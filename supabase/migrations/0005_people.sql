-- People, employment and professional contact points.
--
-- A person carries no title, no department and no employer. All three belong to
-- an assignment, because one person can hold several at once and has held
-- others before.

create table people (
  id uuid primary key default gen_random_uuid(),
  full_name_published text not null,
  name_prefix text,
  first_name text,
  middle_name text,
  last_name text,
  name_suffix text,
  -- Scoped to an organization, not to a state: a federal employee has no state
  -- above them, and two people with the same name at different public bodies
  -- are different people.
  identity_key text not null unique,
  status record_status not null default 'active',
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint people_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint people_has_provenance check (source_document_id is not null)
);

create index people_last_name_idx on people (last_name);

create table employment_assignments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  organizational_unit_id uuid references organizational_units (id) on delete set null,
  -- Where the person actually works, which need not be where the employer sits.
  -- A federal employee may have a duty location in any state without their
  -- employer having a state parent.
  duty_location_id uuid references organization_locations (id) on delete set null,
  title_published text,
  title_normalized text,
  role_category_code text not null default 'unknown' references role_categories (code),
  job_family_code text not null default 'unknown' references job_families (code),
  seniority_code text not null default 'unknown' references seniority_levels (code),
  specialty text,
  normalization_method normalization_method not null default 'rule_table',
  normalization_rule_source text,
  taxonomy_version text not null default '0',
  normalization_confidence numeric(4, 3) not null default 0,
  department_published text,
  is_primary boolean not null default false,
  assignment_status assignment_status not null default 'active',
  effective_from date,
  effective_to date,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint employment_assignments_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint employment_assignments_has_provenance check (source_document_id is not null),
  constraint employment_assignments_dates check (effective_to is null or effective_to >= effective_from),
  -- NULLS NOT DISTINCT: an assignment with no unit and no title is still one
  -- assignment, and re-observing it must update rather than duplicate.
  constraint employment_assignments_unique unique nulls not distinct (
    person_id, organization_id, organizational_unit_id, title_normalized, effective_from
  )
);

create index employment_assignments_person_idx on employment_assignments (person_id);
create index employment_assignments_organization_idx on employment_assignments (organization_id);
create index employment_assignments_role_idx on employment_assignments (role_category_code);
create index employment_assignments_status_idx on employment_assignments (assignment_status);
create index employment_assignments_duty_location_idx on employment_assignments (duty_location_id);

-- Professional contact points other than email.
--
-- Email keeps its own tables because published and inferred addresses must stay
-- structurally apart. Phones, extensions and office addresses have no inferred
-- equivalent, so they live here.
create table contact_points (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people (id) on delete cascade,
  employment_assignment_id uuid references employment_assignments (id) on delete cascade,
  organization_id uuid references organizations (id) on delete cascade,
  contact_point_type_code text not null references contact_point_types (code),
  value text not null,
  value_normalized text not null,
  source_value text,
  is_primary boolean not null default false,
  status record_status not null default 'active',
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint contact_points_has_provenance check (source_document_id is not null),
  -- A contact point belongs to someone or something.
  constraint contact_points_has_owner check (
    person_id is not null or employment_assignment_id is not null or organization_id is not null
  ),
  constraint contact_points_unique unique nulls not distinct (
    person_id, organization_id, contact_point_type_code, value_normalized
  )
);

create index contact_points_person_idx on contact_points (person_id);
create index contact_points_organization_idx on contact_points (organization_id);
create index contact_points_type_idx on contact_points (contact_point_type_code);
