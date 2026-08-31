-- The neutral organization model.
--
-- One table for every public body at every level of government. There is no
-- parent column: hierarchy is effective-dated and lives in
-- organization_relationships, because public-sector reporting lines change,
-- overlap, and occasionally run in more than one direction at once.

create table organizations (
  id uuid primary key default gen_random_uuid(),
  organization_type_code text not null references organization_types (code),
  -- Independent, orthogonal, source-supported classifications.
  --
  -- Not denormalized from the type and deliberately not tied to it by a
  -- composite key. What kind of body this is, what level of government it
  -- belongs to and what work it does are three separate facts: an independent
  -- school district is a `school_district` at the `special_district` level in
  -- the `education` sector, while a city-run one is the same type at the
  -- `municipal` level. The type may suggest defaults during onboarding; the
  -- source decides what is stored.
  government_level_code text not null references government_levels (code),
  sector_code text not null references sectors (code),
  -- Nullable: an organization may be recorded before its jurisdiction is.
  jurisdiction_id uuid references jurisdictions (id) on delete set null,
  name text not null,
  name_normalized text not null,
  name_source_value text,
  legal_name text,
  short_name text,
  website_url text,
  primary_domain text,
  email_domains text[] not null default '{}',
  status record_status not null default 'active',
  -- Identity, resolved by the strongest evidence available.
  --
  -- `identity_fingerprint` is unique, so re-observing the same source record
  -- lands on the same row instead of adding another one. `identity_tier`
  -- records which kind of evidence resolved it, so a weak match is visible
  -- rather than indistinguishable from an official identifier. See
  -- `OrganizationRepository.resolveIdentity` and docs/DATA_MODEL.md.
  identity_tier organization_identity_tier not null,
  identity_fingerprint text not null unique,
  -- True when the evidence was too weak to be sure. The row still exists and is
  -- still stable across recrawls; it is flagged for a person rather than merged
  -- into a look-alike or duplicated on every pass.
  needs_identity_review boolean not null default false,
  identity_review_reason text,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organizations_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint organizations_has_provenance check (source_document_id is not null)
);

create index organizations_type_idx on organizations (organization_type_code);
create index organizations_level_idx on organizations (government_level_code);
create index organizations_sector_idx on organizations (sector_code);
create index organizations_jurisdiction_idx on organizations (jurisdiction_id);
create index organizations_name_idx on organizations (name_normalized);
create index organizations_domain_idx on organizations (primary_domain);
-- The queue a person works from.
create index organizations_identity_review_idx on organizations (first_seen_at)
  where needs_identity_review;

alter table source_policies add constraint source_policies_organization_fk
  foreign key (organization_id) references organizations (id) on delete cascade;
alter table source_policies add constraint source_policies_jurisdiction_fk
  foreign key (jurisdiction_id) references jurisdictions (id) on delete cascade;

-- Effective-dated edges between organizations.
create table organization_relationships (
  id uuid primary key default gen_random_uuid(),
  parent_organization_id uuid not null references organizations (id) on delete cascade,
  child_organization_id uuid not null references organizations (id) on delete cascade,
  relationship_type_code text not null references relationship_types (code),
  effective_from date not null default current_date,
  effective_to date,
  notes text,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organization_relationships_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint organization_relationships_has_provenance check (source_document_id is not null),
  constraint organization_relationships_not_self check (parent_organization_id <> child_organization_id),
  constraint organization_relationships_dates check (effective_to is null or effective_to >= effective_from),
  -- One edge of a given type per pair per start date. Re-observing it updates
  -- the row rather than adding another.
  constraint organization_relationships_unique unique (
    parent_organization_id, child_organization_id, relationship_type_code, effective_from
  )
);

create index organization_relationships_child_idx on organization_relationships (child_organization_id);
create index organization_relationships_parent_idx on organization_relationships (parent_organization_id);

-- A subdivision inside one organization: a division, a section or a team.
create table organizational_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  parent_unit_id uuid references organizational_units (id) on delete set null,
  name text not null,
  name_normalized text not null,
  name_source_value text,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- A unit is a material value read off a page, so it carries evidence like
  -- every other one. This constraint was missing while the column was
  -- nullable, which made `organizational_units` the one provenance-bearing
  -- table a row could enter with nothing behind it.
  constraint organizational_units_has_provenance check (source_document_id is not null),
  constraint organizational_units_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint organizational_units_unique unique nulls not distinct (organization_id, parent_unit_id, name_normalized)
);

create index organizational_units_organization_idx on organizational_units (organization_id);

-- Where an organization physically operates. Independent of its hierarchy.
create table organization_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  location_type text not null default 'office',
  name text,
  address_line1 text,
  address_line2 text,
  city text,
  state_code char(2),
  postal_code text,
  country_code char(2) not null default 'US',
  geographic_area_id uuid references geographic_areas (id) on delete set null,
  is_primary boolean not null default false,
  effective_from date,
  effective_to date,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organization_locations_has_provenance check (source_document_id is not null),
  constraint organization_locations_dates check (effective_to is null or effective_to >= effective_from)
);

create index organization_locations_organization_idx on organization_locations (organization_id);
create index organization_locations_area_idx on organization_locations (geographic_area_id);
create index organization_locations_state_idx on organization_locations (state_code);

-- Officially issued identifiers, generic across every issuing authority.
create table external_identifiers (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  identifier_system_code text not null references identifier_systems (code),
  identifier_value text not null,
  issuing_state_code char(2),
  is_primary boolean not null default false,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint external_identifiers_entity_type check (
    entity_type in ('organization', 'geographic_area', 'jurisdiction', 'person')
  ),
  constraint external_identifiers_has_provenance check (source_document_id is not null),
  -- An identifier value is unique within its system, so two organizations
  -- cannot both claim the same official id.
  constraint external_identifiers_unique unique (identifier_system_code, identifier_value)
);

create index external_identifiers_entity_idx on external_identifiers (entity_type, entity_id);
