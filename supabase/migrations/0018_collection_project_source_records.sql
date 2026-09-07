-- Query and explicitly select provenance-bearing organization source records.

create index organization_spine_records_explorer_idx
  on organization_spine_records (
    organization_type_code,
    sector_code,
    (location ->> 'stateCode'),
    name_normalized,
    id
  );

create table collection_project_source_records (
  project_id uuid not null references collection_projects (id) on delete cascade,
  source_record_id uuid not null references organization_spine_records (id) on delete restrict,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (project_id, source_record_id)
);

create index collection_project_source_records_record_idx
  on collection_project_source_records (source_record_id);

alter table collection_project_source_records enable row level security;
alter table collection_project_source_records force row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on collection_project_source_records from %I', role_name);
    end if;
  end loop;
end;
$$;
