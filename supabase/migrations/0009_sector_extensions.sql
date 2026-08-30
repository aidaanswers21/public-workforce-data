-- Sector-specific extension tables, keyed to organizations.id.
--
-- Attributes that only one vertical has live here rather than as nullable
-- columns on the neutral organization row. A county government has no grade
-- range, and adding one to a shared table is how a neutral model quietly stops
-- being neutral.

create table education_organization_attributes (
  organization_id uuid primary key references organizations (id) on delete cascade,
  -- Published grade tokens, not normalized to numbers: sources use PK, KG, K, 01.
  low_grade text,
  high_grade text,
  school_type text,
  operational_status text,
  is_charter boolean,
  is_magnet boolean,
  is_virtual boolean,
  enrollment integer,
  enrollment_as_of date,
  title_one_status text,
  source_document_id uuid references source_documents (id) on delete set null,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint education_attributes_enrollment_positive check (enrollment is null or enrollment >= 0),
  constraint education_attributes_has_provenance check (source_document_id is not null)
);

-- A guard, not decoration: this extension may only describe organizations whose
-- type belongs to the education sector.
create or replace function education_attributes_sector_guard() returns trigger as $$
declare
  org_sector text;
begin
  select sector_code into org_sector from organizations where id = new.organization_id;
  if org_sector is distinct from 'education' then
    raise exception 'education_organization_attributes may only describe education-sector organizations (got %)', coalesce(org_sector, 'unknown');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger education_attributes_sector_guard_trigger
  before insert or update on education_organization_attributes
  for each row execute function education_attributes_sector_guard();
