-- Durable staging for bulk organization releases before canonical import.

create type organization_spine_record_status as enum (
  'ready_to_import',
  'imported',
  'classification_hold',
  'overlay_hold',
  'reconciliation_hold',
  'failed'
);

create table organization_spine_records (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  source_record_key text not null,
  name text not null,
  name_normalized text not null,
  organization_type_code text references organization_types (code),
  government_level_code text references government_levels (code),
  sector_code text references sectors (code),
  classification_review_reason text,
  website_url text,
  primary_domain text,
  identifiers jsonb not null default '[]'::jsonb,
  parent_identifiers jsonb not null default '[]'::jsonb,
  location jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  status organization_spine_record_status not null,
  organization_id uuid references organizations (id) on delete set null,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  source_document_version_id uuid not null,
  source_effective_date date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organization_spine_records_unique_version unique (
    source_key, source_record_key, source_document_version_id
  ),
  constraint organization_spine_records_has_provenance check (
    source_document_id is not null and source_document_version_id is not null
  ),
  constraint organization_spine_records_version_provenance foreign key (
    source_document_version_id, source_document_id
  ) references source_document_versions (id, source_document_id) on delete restrict,
  constraint organization_spine_records_identifiers_array
    check (jsonb_typeof(identifiers) = 'array'),
  constraint organization_spine_records_parent_identifiers_array
    check (jsonb_typeof(parent_identifiers) = 'array'),
  constraint organization_spine_records_location_object
    check (jsonb_typeof(location) = 'object'),
  constraint organization_spine_records_attributes_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint organization_spine_records_ready_complete check (
    status not in ('ready_to_import', 'imported') or (
      organization_type_code is not null
      and government_level_code is not null
      and sector_code is not null
      and classification_review_reason is null
      and jsonb_array_length(identifiers) > 0
    )
  ),
  constraint organization_spine_records_import_link check (
    status <> 'imported' or organization_id is not null
  )
);

create index organization_spine_records_status_idx
  on organization_spine_records (status, source_key, id);
create index organization_spine_records_organization_idx
  on organization_spine_records (organization_id) where organization_id is not null;
create index organization_spine_records_classification_idx
  on organization_spine_records (
    government_level_code, sector_code, organization_type_code, status
  );
create index organization_spine_records_state_idx
  on organization_spine_records ((location ->> 'stateCode'), status);

alter table organization_spine_records enable row level security;
alter table organization_spine_records force row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on organization_spine_records from %I', role_name);
    end if;
  end loop;
end;
$$;
