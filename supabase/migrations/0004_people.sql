create table people (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references states (id) on delete cascade,
  full_name_published text not null,
  name_prefix text,
  first_name text,
  middle_name text,
  last_name text,
  name_suffix text,
  identity_key text not null,
  status record_status not null default 'active',
  source_page_id uuid references source_pages (id) on delete set null,
  inference_evidence_id uuid,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint people_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint people_has_provenance check (source_page_id is not null or inference_evidence_id is not null),
  -- Identity is scoped to a state and an organization, so two people with the
  -- same name in different districts stay separate rows.
  constraint people_identity_unique unique (state_id, identity_key)
);

create index people_last_name_idx on people (state_id, last_name);

create table employment_assignments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people (id) on delete cascade,
  district_id uuid references districts (id) on delete cascade,
  school_id uuid references schools (id) on delete cascade,
  department_id uuid references departments (id) on delete set null,
  title_published text,
  title_normalized text,
  role_category role_category not null default 'unknown',
  seniority seniority_level not null default 'unknown',
  specialty text,
  is_primary boolean not null default false,
  status record_status not null default 'active',
  source_page_id uuid references source_pages (id) on delete set null,
  inference_evidence_id uuid,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint employment_assignments_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint employment_assignments_has_provenance check (source_page_id is not null or inference_evidence_id is not null),
  -- An assignment must attach to somewhere.
  constraint employment_assignments_has_org check (district_id is not null or school_id is not null),
  -- NULLS NOT DISTINCT: a district-level assignment has a null school_id, and
  -- two such rows for the same person and title are the same assignment.
  constraint employment_unique_role unique nulls not distinct (person_id, district_id, school_id, title_normalized)
);

create index employment_person_idx on employment_assignments (person_id);
create index employment_school_idx on employment_assignments (school_id);
create index employment_district_idx on employment_assignments (district_id);
create index employment_role_idx on employment_assignments (role_category);
