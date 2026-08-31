-- Suppression, complaints, exports and the audit trail.
--
-- These are the tables a regulator or a complainant would ask about, so they
-- are append-only by construction rather than by convention. The audit trail
-- comes first because suppression revocation writes into it.

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null
);

create index audit_events_entity_idx on audit_events (entity_type, entity_id);
create index audit_events_occurred_idx on audit_events (occurred_at desc);

create or replace function audit_events_append_only() returns trigger as $$
begin
  raise exception 'audit_events is append-only';
end;
$$ language plpgsql;

create trigger audit_events_append_only_trigger
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

-- The canonical audit hash, computed in one place.
--
-- Every writer uses this: the repository, and the suppression revocation
-- trigger. Computing it in the application and again in a trigger would give
-- two chains that disagree, and the disagreement would look exactly like
-- tampering. `payload::text` is stable because Postgres normalizes jsonb key
-- order on output.
create or replace function audit_event_hash(
  prev_hash text,
  actor text,
  action text,
  entity_type text,
  entity_id uuid,
  payload jsonb
) returns text as $$
  select encode(
    sha256(
      convert_to(
        coalesce(prev_hash, '') || '|' || actor || '|' || action || '|' || entity_type || '|'
          || coalesce(entity_id::text, '') || '|' || coalesce(payload, '{}'::jsonb)::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$ language sql immutable;

-- Append one event, chained to the last one.
create or replace function audit_event_append(
  p_actor text,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb
) returns uuid as $$
declare
  v_prev text;
  v_hash text;
  v_id uuid;
begin
  select hash into v_prev from audit_events order by occurred_at desc, id desc limit 1;
  v_hash := audit_event_hash(v_prev, p_actor, p_action, p_entity_type, p_entity_id, p_payload);
  insert into audit_events (actor, action, entity_type, entity_id, payload, prev_hash, hash)
  values (p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb), v_prev, v_hash)
  returning id into v_id;
  return v_id;
end;
$$ language plpgsql;

-- Suppression, complaints, exports and the audit trail.
--
-- These are the tables a regulator or a complainant would ask about, so they
-- are append-only by construction rather than by convention.

create table suppression_entries (
  id uuid primary key default gen_random_uuid(),
  scope suppression_scope not null,
  value text not null,
  -- Restrict, never cascade.
  --
  -- A cascade here would delete an opt-out because the thing it names was
  -- deleted, which is the one outcome suppression exists to prevent. The
  -- immutability trigger already blocks a direct delete, so a cascade would
  -- also be a rule the database contradicts one statement later. Restrict says
  -- the same thing once: while an opt-out points at a row, that row stays.
  person_id uuid references people (id) on delete restrict,
  organization_id uuid references organizations (id) on delete restrict,
  jurisdiction_id uuid references jurisdictions (id) on delete restrict,
  geographic_area_id uuid references geographic_areas (id) on delete restrict,
  source_document_id uuid references source_documents (id) on delete restrict,
  government_level_code text references government_levels (code),
  export_purpose text,
  reason text not null,
  source suppression_source not null,
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint suppression_expires_after_effective check (expires_at is null or expires_at > effective_at),
  constraint suppression_revoked_has_reason check (revoked_at is null or revoked_reason is not null),
  -- Each scope must name what it covers, so an entry can never match nothing.
  constraint suppression_scope_target check (
    (scope in ('email', 'domain') and value <> '')
    or (scope = 'person' and person_id is not null)
    or (scope in ('organization', 'organization_subtree') and organization_id is not null)
    or (scope = 'jurisdiction' and jurisdiction_id is not null)
    or (scope = 'geographic_area' and geographic_area_id is not null)
    or (scope = 'source' and source_document_id is not null)
    or (scope = 'government_level' and government_level_code is not null)
    or (scope = 'export_purpose' and export_purpose is not null)
    or scope = 'global'
  )
);

create index suppression_scope_value_idx on suppression_entries (scope, value) where revoked_at is null;
create index suppression_person_idx on suppression_entries (person_id) where revoked_at is null;
create index suppression_organization_idx on suppression_entries (organization_id) where revoked_at is null;
create index suppression_jurisdiction_idx on suppression_entries (jurisdiction_id) where revoked_at is null;

-- Suppression rows may only be revoked, never edited or deleted, and a
-- revocation may only ever happen once.
--
-- Monotonicity is the point. Without it, "revoked" is a field anyone with write
-- access can toggle, so an opt-out could be revoked, silently un-revoked, and
-- revoked again at a different time, leaving no trace of which window actually
-- applied. Null to a timestamp, once, with a reason, and never back.
create or replace function suppression_entries_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'suppression_entries rows cannot be deleted; revoke them instead';
  end if;

  if row(new.scope, new.value, new.person_id, new.organization_id, new.jurisdiction_id,
         new.geographic_area_id, new.source_document_id, new.government_level_code,
         new.export_purpose, new.reason, new.source, new.effective_at, new.expires_at,
         new.created_by, new.created_at)
     is distinct from
     row(old.scope, old.value, old.person_id, old.organization_id, old.jurisdiction_id,
         old.geographic_area_id, old.source_document_id, old.government_level_code,
         old.export_purpose, old.reason, old.source, old.effective_at, old.expires_at,
         old.created_by, old.created_at) then
    raise exception 'suppression_entries rows are immutable except for revocation';
  end if;

  if old.revoked_at is not null then
    if new.revoked_at is null then
      raise exception 'a revoked suppression entry cannot be un-revoked';
    end if;
    if new.revoked_at is distinct from old.revoked_at then
      raise exception 'revoked_at cannot be changed once set';
    end if;
    if new.revoked_reason is distinct from old.revoked_reason then
      raise exception 'revoked_reason cannot be changed once set';
    end if;
  end if;

  if old.revoked_at is null and new.revoked_at is not null then
    if new.revoked_reason is null or new.revoked_reason = '' then
      raise exception 'a revocation must record why';
    end if;
    -- Revocation is an act on an opt-out, so it lands in the hash-chained
    -- audit log whether it came through the repository or through raw SQL.
    -- One appender, so the chain cannot fork.
    perform audit_event_append(
      coalesce(current_setting('app.actor', true), 'database'),
      'suppression.revoked',
      'suppression_entry',
      new.id,
      jsonb_build_object(
        'scope', new.scope,
        'revokedAt', new.revoked_at,
        'revokedReason', new.revoked_reason
      )
    );
  end if;

  return new;
end;
$$ language plpgsql;

create trigger suppression_entries_immutable_trigger
  before update or delete on suppression_entries
  for each row execute function suppression_entries_immutable();

-- A complaint is recorded whether or not it can be acted on automatically.
--
-- Phone and postal complaints usually arrive without an email address, and an
-- email address is the only thing the suppression list can match on its own. A
-- complaint that cannot be resolved to a person is not a failure and is not
-- discarded: it is recorded, marked for a person to look at, and left with no
-- suppression entry rather than an invalid one.
create table complaints (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  channel complaint_channel not null,
  contact_type text not null,
  contact_value text not null,
  reason text not null,
  notes text,
  person_id uuid references people (id) on delete restrict,
  resolution complaint_resolution not null default 'pending',
  review_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  suppression_entry_id uuid references suppression_entries (id) on delete restrict,
  created_at timestamptz not null default now(),
  -- A complaint that produced suppression must say who it protected; one that
  -- did not must say why a person has to look at it. Neither state is silent.
  constraint complaints_resolution_consistent check (
    (resolution = 'suppressed' and suppression_entry_id is not null)
    or (resolution = 'needs_review' and review_reason is not null and suppression_entry_id is null)
    or (resolution = 'pending' and suppression_entry_id is null)
    or (resolution = 'dismissed' and review_reason is not null)
  ),
  constraint complaints_reviewed_together check (
    (reviewed_by is null) = (reviewed_at is null)
  )
);

create index complaints_contact_idx on complaints (contact_value);
create index complaints_person_idx on complaints (person_id);
-- The queue a person actually works from.
create index complaints_review_idx on complaints (received_at) where resolution = 'needs_review';

create table exports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  requested_by text not null,
  -- Declared purpose, checked against export_purpose suppression entries.
  purpose text not null,
  filters jsonb not null default '{}'::jsonb,
  status export_status not null default 'requested',
  row_count integer not null default 0,
  suppressed_count integer not null default 0,
  file_path text,
  checksum text,
  suppression_checked_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A completed export must prove when suppression was last applied.
  constraint exports_completed_requires_suppression_check check (
    status <> 'completed' or (suppression_checked_at is not null and checksum is not null)
  )
);
