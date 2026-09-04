-- Corrections from the second architecture review.
--
-- This migration is additive because 0001 through 0010 may already be present
-- in a local feature-branch database. It upgrades those databases without
-- changing an applied migration's checksum.

-- One database-owned ordering for every audit writer. The sequence is assigned
-- while holding the append lock and is part of the hash, so timestamp ties
-- cannot make traversal ambiguous.
create sequence audit_event_sequence as bigint;

alter table audit_events
  add column sequence_number bigint,
  add column actor_type text not null default 'application';

alter table audit_events disable trigger audit_events_append_only_trigger;

do $$
declare
  event record;
begin
  for event in select id from audit_events order by occurred_at, id loop
    update audit_events
    set sequence_number = nextval('audit_event_sequence')
    where id = event.id;
  end loop;
end;
$$;

alter table audit_events
  alter column sequence_number set default nextval('audit_event_sequence'),
  alter column sequence_number set not null,
  add constraint audit_events_sequence_unique unique (sequence_number);

drop function audit_event_hash(text, text, text, text, uuid, jsonb);

-- Canonical database serialization for the audit chain. jsonb gives every
-- component a typed boundary, unlike delimiter concatenation, and PostgreSQL
-- canonicalizes object-key order. Timestamps are normalized to UTC explicitly
-- so the session time zone cannot change a hash.
create function audit_event_hash(
  p_previous_hash text,
  p_sequence_number bigint,
  p_occurred_at timestamptz,
  p_actor_type text,
  p_actor_identifier text,
  p_action text,
  p_subject_type text,
  p_subject_identifier uuid,
  p_metadata jsonb
) returns text as $$
  select encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'version', 1,
          'previousHash', p_previous_hash,
          'sequenceNumber', p_sequence_number,
          'occurredAt', to_char(
            p_occurred_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'actorType', p_actor_type,
          'actorIdentifier', p_actor_identifier,
          'action', p_action,
          'subjectType', p_subject_type,
          'subjectIdentifier', p_subject_identifier,
          'metadata', coalesce(p_metadata, '{}'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$ language sql immutable;

-- Rebuild any feature-branch events with the canonical formula. The immutable
-- trigger is disabled only inside this migration and is restored below.
do $$
declare
  event record;
  previous_hash text := null;
  canonical_hash text;
begin
  for event in
    select id, sequence_number, occurred_at, actor_type, actor, action,
           entity_type, entity_id, payload
    from audit_events order by sequence_number
  loop
    canonical_hash := audit_event_hash(
      previous_hash,
      event.sequence_number,
      event.occurred_at,
      event.actor_type,
      event.actor,
      event.action,
      event.entity_type,
      event.entity_id,
      event.payload
    );
    update audit_events
    set prev_hash = previous_hash, hash = canonical_hash
    where id = event.id;
    previous_hash := canonical_hash;
  end loop;
end;
$$;

alter table audit_events enable trigger audit_events_append_only_trigger;

drop function audit_event_append(text, text, text, uuid, jsonb);

-- Every application and trigger append enters here. The transaction-scoped
-- advisory lock serializes the empty-chain case as well as established chains.
create function audit_event_append(
  p_actor_identifier text,
  p_action text,
  p_subject_type text,
  p_subject_identifier uuid,
  p_metadata jsonb,
  p_actor_type text default 'application',
  p_occurred_at timestamptz default null
) returns uuid as $$
declare
  v_previous_hash text;
  v_sequence_number bigint;
  v_occurred_at timestamptz;
  v_hash text;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(734878942635191126);

  select hash into v_previous_hash
  from audit_events
  order by sequence_number desc
  limit 1;

  v_sequence_number := nextval('audit_event_sequence');
  v_occurred_at := coalesce(p_occurred_at, clock_timestamp());
  v_hash := audit_event_hash(
    v_previous_hash,
    v_sequence_number,
    v_occurred_at,
    p_actor_type,
    p_actor_identifier,
    p_action,
    p_subject_type,
    p_subject_identifier,
    coalesce(p_metadata, '{}'::jsonb)
  );

  insert into audit_events (
    sequence_number, occurred_at, actor_type, actor, action, entity_type,
    entity_id, payload, prev_hash, hash
  ) values (
    v_sequence_number, v_occurred_at, p_actor_type, p_actor_identifier,
    p_action, p_subject_type, p_subject_identifier,
    coalesce(p_metadata, '{}'::jsonb), v_previous_hash, v_hash
  ) returning id into v_id;

  return v_id;
end;
$$ language plpgsql security definer set search_path = pg_catalog, public;

-- Revocation is trigger-owned. The actor settings are transaction-local values
-- set by the repository; raw SQL receives an honest database actor instead.
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
    perform audit_event_append(
      coalesce(current_setting('app.actor_identifier', true), 'database'),
      'suppression.revoked',
      'suppression_entry',
      new.id,
      jsonb_build_object(
        'scope', new.scope,
        'revokedAt', new.revoked_at,
        'revokedReason', new.revoked_reason
      ),
      coalesce(current_setting('app.actor_type', true), 'database')
    );
  end if;

  return new;
end;
$$ language plpgsql;

-- Exact complaint-delivery retries address the existing record instead of
-- creating another complaint and another suppression.
alter table complaints
  add column idempotency_key text,
  add column contact_value_normalized text,
  add column created_by text;

update complaints
set idempotency_key = 'legacy:' || id::text,
    contact_value_normalized = case
      when lower(trim(contact_type)) = 'email' then lower(trim(contact_value))
      when lower(trim(contact_type)) = 'phone' then
        case
          when length(regexp_replace(contact_value, '\D', '', 'g')) = 11
            and left(regexp_replace(contact_value, '\D', '', 'g'), 1) = '1'
          then substring(regexp_replace(contact_value, '\D', '', 'g') from 2)
          else regexp_replace(contact_value, '\D', '', 'g')
        end
      when lower(trim(contact_type)) = 'postal'
        then lower(regexp_replace(trim(contact_value), '\s+', ' ', 'g'))
      else trim(contact_value)
    end,
    created_by = 'legacy-migration'
where idempotency_key is null;

alter table complaints
  alter column idempotency_key set not null,
  alter column contact_value_normalized set not null,
  alter column created_by set not null,
  add constraint complaints_idempotency_key_unique unique (idempotency_key),
  drop constraint complaints_resolution_consistent,
  add constraint complaints_resolution_consistent check (
    (resolution = 'suppressed' and suppression_entry_id is not null)
    or (resolution = 'needs_review' and review_reason is not null)
    or (resolution = 'pending' and suppression_entry_id is null)
    or (resolution = 'dismissed' and review_reason is not null)
  );

create index complaints_contact_normalized_idx
  on complaints (contact_type, contact_value_normalized);

alter table exports
  add column withheld_candidate_count integer not null default 0,
  add constraint exports_withheld_candidate_count_nonnegative
    check (withheld_candidate_count >= 0);

-- Identity evidence preserves every observed name, source-local key and URL
-- after the canonical organization row is reconciled to stronger evidence.
create table organization_identity_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete restrict,
  evidence_type text not null,
  evidence_system text,
  evidence_value text not null,
  evidence_value_normalized text not null,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organization_identity_evidence_type check (
    evidence_type in (
      'name', 'official_identifier', 'source_identifier', 'source_url', 'identity_fingerprint'
    )
  ),
  constraint organization_identity_evidence_has_provenance
    check (source_document_id is not null),
  constraint organization_identity_evidence_unique
    unique nulls not distinct (
      organization_id, evidence_type, evidence_system, evidence_value_normalized,
      source_document_id
    )
);

create index organization_identity_evidence_lookup_idx
  on organization_identity_evidence (evidence_type, evidence_system, evidence_value_normalized);

-- 0010 secured the tables that existed at that point. PostgreSQL default
-- privileges do not enable RLS on future tables, so every later table must do
-- this explicitly and the schema test enforces the rule in CI.
alter table organization_identity_evidence enable row level security;
alter table organization_identity_evidence force row level security;

-- Audit primitives are not a public API. SECURITY DEFINER lets the suppression
-- trigger call the appender after PUBLIC execution is revoked. The table owner
-- retains execution for migrations and local tests; Supabase's service role is
-- granted only when that role exists.
revoke all on function audit_event_hash(
  text, bigint, timestamptz, text, text, text, text, uuid, jsonb
) from public;
revoke all on function audit_event_append(
  text, text, text, uuid, jsonb, text, timestamptz
) from public;

do $$
declare
  role_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function audit_event_hash(
      text, bigint, timestamptz, text, text, text, text, uuid, jsonb
    ) to service_role;
    grant execute on function audit_event_append(
      text, text, text, uuid, jsonb, text, timestamptz
    ) to service_role;
  end if;

  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on table organization_identity_evidence from %I', role_name
      );
    end if;
  end loop;
end;
$$;

-- An observation cannot be changed within a document version. Exact replay is
-- handled by INSERT ... ON CONFLICT DO NOTHING in the repository.
drop trigger source_observations_append_only_trigger on source_observations;
create trigger source_observations_append_only_trigger
  before update or delete on source_observations
  for each row execute function source_observations_append_only();
