-- Geography and jurisdiction, kept apart from each other and from employer
-- hierarchy.
--
-- A federal office sits in a county without the county having any authority
-- over it. A school belongs to a district organizationally while sitting in a
-- municipality physically. Neither fact is allowed to imply the other.

create table geographic_areas (
  id uuid primary key default gen_random_uuid(),
  area_type_code text not null references geographic_area_types (code),
  name text not null,
  name_normalized text not null,
  parent_area_id uuid references geographic_areas (id) on delete set null,
  -- Two letter postal abbreviation, when the area is or sits in a state.
  state_code char(2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint geographic_areas_unique unique nulls not distinct (area_type_code, name_normalized, parent_area_id)
);

create index geographic_areas_parent_idx on geographic_areas (parent_area_id);
create index geographic_areas_state_idx on geographic_areas (state_code);

-- The authority an organization operates under.
--
-- `geographic_area_id` is nullable because a nationwide body has a jurisdiction
-- and no bounding area, and `parent_jurisdiction_id` is nullable because a
-- federal jurisdiction has nothing above it.
create table jurisdictions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  government_level_code text not null references government_levels (code),
  geographic_area_id uuid references geographic_areas (id) on delete set null,
  parent_jurisdiction_id uuid references jurisdictions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jurisdictions_level_idx on jurisdictions (government_level_code);
create index jurisdictions_area_idx on jurisdictions (geographic_area_id);

alter table crawl_runs add constraint crawl_runs_jurisdiction_fk
  foreign key (jurisdiction_id) references jurisdictions (id) on delete set null;
