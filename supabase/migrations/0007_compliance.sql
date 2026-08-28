-- Suppression, complaints, exports and the audit trail.
--
-- The tables in this file are the ones a regulator or a complainant would ask
-- about, so they are append-only by construction rather than by convention.

create table suppression_entries (
  id uuid primary key default gen_random_uuid(),
  scope suppression_scope not null,
  value text not null,
  person_id uuid references people (id) on delete cascade,
  school_id uuid references schools (id) on delete cascade,
  district_id uuid references districts (id) on delete cascade,
  state_id uuid references states (id) on delete cascade,
  reason text not null,
  source suppression_source not null,
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint suppression_expires_after_effective check (expires_at is null or expires_at > effective_at),
  constraint suppression_revoked_has_reason check (revoked_at is null or revoked_reason is not null)
);

create index suppression_scope_value_idx on suppression_entries (scope, value) where revoked_at is null;
create index suppression_person_idx on suppression_entries (person_id) where revoked_at is null;
create index suppression_district_idx on suppression_entries (district_id) where revoked_at is null;

-- Suppression rows may only be revoked, never edited or deleted. Revocation is
-- itself recorded on the row, so the history of an opt-out is always readable.
create or replace function suppression_entries_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'suppression_entries rows cannot be deleted; revoke them instead';
  end if;
  if row(new.scope, new.value, new.person_id, new.school_id, new.district_id, new.state_id,
         new.reason, new.source, new.effective_at, new.expires_at, new.created_by, new.created_at)
     is distinct from
     row(old.scope, old.value, old.person_id, old.school_id, old.district_id, old.state_id,
         old.reason, old.source, old.effective_at, old.expires_at, old.created_by, old.created_at) then
    raise exception 'suppression_entries rows are immutable except for revocation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger suppression_entries_immutable_trigger
  before update or delete on suppression_entries
  for each row execute function suppression_entries_immutable();

create table complaints (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  channel complaint_channel not null,
  contact_type text not null,
  contact_value text not null,
  reason text not null,
  notes text,
  suppression_entry_id uuid references suppression_entries (id) on delete set null,
  created_at timestamptz not null default now()
);

create index complaints_contact_idx on complaints (contact_value);

create table exports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  requested_by text not null,
  filters jsonb not null default '{}'::jsonb,
  status export_status not null default 'requested',
  row_count integer not null default 0,
  suppressed_count integer not null default 0,
  file_path text,
  checksum text,
  suppression_checked_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A completed export must be able to prove when suppression was last applied.
  constraint exports_completed_requires_suppression_check check (
    status <> 'completed' or (suppression_checked_at is not null and checksum is not null)
  )
);

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

-- The audit trail is strictly append-only.
create or replace function audit_events_append_only() returns trigger as $$
begin
  raise exception 'audit_events is append-only';
end;
$$ language plpgsql;

create trigger audit_events_append_only_trigger
  before update or delete on audit_events
  for each row execute function audit_events_append_only();
