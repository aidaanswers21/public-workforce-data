-- Controlled reference data and the genuinely closed enums.
--
-- Reference tables hold anything a new public-sector vertical might extend:
-- organization types, sectors, role categories, identifier systems, source
-- types. Adding one of those is a seeded row, never a migration. Enums are used
-- only where the set is closed and the application branches on every value.

create table government_levels (
  code text primary key,
  name text not null,
  description text not null,
  sort_order integer not null default 0,
  retired_at timestamptz
);

create table sectors (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

-- What kind of public body an organization is.
--
-- The level and sector here are defaults for onboarding, not constraints on the
-- data. Government level and sector are orthogonal attributes recorded on the
-- organization itself, because a school district is an independent special
-- district in most states and a department of a city or county in others. Both
-- defaults are nullable for exactly that reason, and there is deliberately no
-- composite key from an organization back to this triple: such a key would
-- force every school, and every public authority, into one level and one sector
-- for good.
create table organization_types (
  code text primary key,
  name text not null,
  description text not null,
  default_government_level_code text references government_levels (code),
  default_sector_code text references sectors (code),
  typically_subordinate boolean not null default false,
  retired_at timestamptz
);

-- How a value was pulled off a source. Open by construction.
--
-- Reference data rather than an enum because this list grows every time a new
-- source format appears: a new document type, a new API shape, a new extraction
-- strategy. Requiring a migration to record that a value came out of a PDF
-- table is how a platform ends up recording it as `other` instead.
create table extraction_methods (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

-- How a published address was hidden before it was decoded. Also open: every
-- new anti-harvesting trick is another row here.
create table obfuscation_kinds (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

create table relationship_types (
  code text primary key,
  name text not null,
  description text not null,
  reading_from_child text not null,
  -- Whether suppression and coverage roll down through this relationship.
  implies_subtree boolean not null default false,
  retired_at timestamptz
);

create table geographic_area_types (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

create table identifier_systems (
  code text primary key,
  name text not null,
  description text not null,
  applies_to text not null,
  pattern text,
  authority text not null,
  retired_at timestamptz,
  constraint identifier_systems_applies_to check (
    applies_to in ('organization', 'geographic_area', 'jurisdiction', 'person')
  )
);

create table source_types (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

create table evidence_classes (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

create table job_families (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

create table role_categories (
  code text primary key,
  name text not null,
  description text not null,
  job_family_code text not null references job_families (code),
  retired_at timestamptz
);

create table seniority_levels (
  code text primary key,
  name text not null,
  description text not null,
  sort_order integer not null default 0,
  retired_at timestamptz
);

create table contact_point_types (
  code text primary key,
  name text not null,
  description text not null,
  retired_at timestamptz
);

-- Closed vocabularies. Mirrored by packages/shared-types/src/enums.ts.
create type email_classification as enum (
  'published', 'decoded_published', 'inferred_candidate', 'general_inbox', 'invalid', 'suppressed'
);

create type email_validation_status as enum (
  'unvalidated', 'valid', 'invalid', 'risky', 'accept_all', 'unknown', 'error'
);

create type suppression_scope as enum (
  'person', 'email', 'domain', 'organization', 'organization_subtree', 'source',
  'jurisdiction', 'government_level', 'geographic_area', 'export_purpose', 'global'
);

create type suppression_source as enum (
  'complaint', 'opt_out_request', 'legal_request', 'source_policy', 'bounce',
  'manual_review', 'policy', 'import'
);

create type complaint_channel as enum ('email', 'phone', 'web_form', 'mail', 'regulator', 'other');

-- What happened to a complaint. A closed lifecycle: every complaint is waiting,
-- acted on, waiting for a person, or closed without action.
create type complaint_resolution as enum ('pending', 'suppressed', 'needs_review', 'dismissed');

-- How an organization's identity was resolved, strongest first.
--
-- A closed set: these are the only kinds of evidence the resolver knows how to
-- weigh, and adding one is a deliberate change to how records are matched.
create type organization_identity_tier as enum (
  'official_identifier',
  'source_identifier',
  'parent_scoped_name',
  'domain_scoped_name',
  'ambiguous'
);

create type assignment_status as enum ('active', 'inactive', 'historical', 'unknown');

create type collection_status as enum ('permitted', 'prohibited', 'review_required', 'unknown');

create type policy_stance as enum ('permitted', 'prohibited', 'restricted', 'unknown');

create type crawl_run_status as enum (
  'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'
);

create type crawl_page_status as enum ('pending', 'fetched', 'parsed', 'skipped', 'failed', 'blocked');

create type crawl_target_status as enum (
  'pending', 'discovering', 'ready', 'crawling', 'crawled', 'failed', 'blocked',
  'excluded', 'policy_hold', 'unsupported_platform'
);

create type crawl_target_type as enum (
  'organization_site', 'organization_directory', 'unit_directory', 'profile_page',
  'api_endpoint', 'dataset', 'document'
);

create type crawl_error_type as enum (
  'network', 'timeout', 'http_error', 'parse_error', 'adapter_error', 'robots_disallowed',
  'blocked_by_source', 'source_policy_refusal', 'requires_authentication', 'captcha',
  'unsupported_platform', 'policy_violation', 'internal'
);

create type email_candidate_state as enum ('pending', 'validated', 'promoted', 'rejected', 'suppressed');

create type export_status as enum ('requested', 'building', 'completed', 'failed', 'blocked');

create type record_status as enum ('active', 'inactive', 'unconfirmed');


create type normalization_method as enum ('rule_table', 'exact_match', 'manual', 'assisted_review');
