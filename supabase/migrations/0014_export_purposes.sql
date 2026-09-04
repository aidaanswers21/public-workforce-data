-- API callers may only use a purpose that a named human has approved.
-- Purpose codes are reference data because the set grows with reviewed uses.

create table export_purposes (
  code text primary key,
  description text not null,
  owner text not null,
  approved_by text not null,
  approved_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint export_purposes_code_format check (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint export_purposes_owner_present check (btrim(owner) <> ''),
  constraint export_purposes_approver_present check (btrim(approved_by) <> ''),
  constraint export_purposes_retirement_consistent check (
    (active and retired_at is null) or (not active and retired_at is not null)
  )
);

alter table export_purposes enable row level security;
alter table export_purposes force row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on export_purposes from %I', role_name);
    end if;
  end loop;
end;
$$;
