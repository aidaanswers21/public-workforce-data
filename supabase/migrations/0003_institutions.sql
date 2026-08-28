create table states (
  id uuid primary key default gen_random_uuid(),
  code char(2) not null unique,
  name text not null,
  fips_code text,
  config_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crawl_runs add constraint crawl_runs_state_fk
  foreign key (state_id) references states (id) on delete set null;

create table counties (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references states (id) on delete cascade,
  name text not null,
  name_normalized text not null,
  fips_code text,
  source_value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint counties_unique_per_state unique (state_id, name_normalized)
);

create table districts (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references states (id) on delete cascade,
  county_id uuid references counties (id) on delete set null,
  name text not null,
  name_normalized text not null,
  name_source_value text,
  nces_id text,
  state_agency_id text,
  federal_ein text,
  website_url text,
  primary_domain text,
  email_domains text[] not null default '{}',
  status record_status not null default 'active',
  source_page_id uuid references source_pages (id) on delete set null,
  inference_evidence_id uuid,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint districts_confidence_range check (confidence >= 0 and confidence <= 1),
  -- Traceability is structural: a district row exists because a page or an
  -- inference produced it, never because something wrote it with no evidence.
  constraint districts_has_provenance check (source_page_id is not null or inference_evidence_id is not null),
  constraint districts_nces_unique unique (state_id, nces_id),
  constraint districts_agency_unique unique (state_id, state_agency_id)
);

create index districts_state_name_idx on districts (state_id, name_normalized);
create index districts_domain_idx on districts (primary_domain);

create table schools (
  id uuid primary key default gen_random_uuid(),
  district_id uuid not null references districts (id) on delete cascade,
  state_id uuid not null references states (id) on delete cascade,
  county_id uuid references counties (id) on delete set null,
  name text not null,
  name_normalized text not null,
  name_source_value text,
  nces_id text,
  state_agency_id text,
  federal_ein text,
  school_level text,
  low_grade text,
  high_grade text,
  website_url text,
  primary_domain text,
  status record_status not null default 'active',
  source_page_id uuid references source_pages (id) on delete set null,
  inference_evidence_id uuid,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint schools_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint schools_has_provenance check (source_page_id is not null or inference_evidence_id is not null),
  constraint schools_nces_unique unique (state_id, nces_id),
  constraint schools_agency_unique unique (state_id, state_agency_id)
);

create index schools_district_idx on schools (district_id);
create index schools_state_name_idx on schools (state_id, name_normalized);

create table departments (
  id uuid primary key default gen_random_uuid(),
  scope org_scope not null,
  scope_id uuid not null,
  name text not null,
  name_normalized text not null,
  name_source_value text,
  source_page_id uuid references source_pages (id) on delete set null,
  inference_evidence_id uuid,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint departments_unique_per_scope unique (scope, scope_id, name_normalized)
);
