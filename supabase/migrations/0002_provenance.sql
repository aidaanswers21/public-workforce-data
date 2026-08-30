-- Provenance and source policy.
--
-- These come first because every organization, person and address references a
-- source document, and no document may be retrieved without a policy decision
-- behind it.

create table crawl_runs (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid,
  run_type text not null,
  status crawl_run_status not null default 'queued',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  initiated_by text not null,
  constraint crawl_runs_finished_after_started check (finished_at is null or finished_at >= started_at)
);

create index crawl_runs_started_idx on crawl_runs (started_at desc);

-- A recorded decision about whether, and on what terms, a source may be used.
-- Organization and jurisdiction foreign keys are added in 0004, once those
-- tables exist; declaring them here would make the dependency order circular.
create table source_policies (
  id uuid primary key default gen_random_uuid(),
  domain text,
  url_pattern text,
  organization_id uuid,
  jurisdiction_id uuid,
  source_type_code text references source_types (code),
  collection_status collection_status not null default 'unknown',
  commercial_use_status policy_stance not null default 'unknown',
  solicitation_status policy_stance not null default 'unknown',
  automated_access_status policy_stance not null default 'unknown',
  policy_url text,
  policy_text_snapshot text,
  policy_text_hash text,
  effective_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  reviewed_by text,
  review_notes text,
  production_approved_by text,
  production_approved_at timestamptz,
  production_approval_note text,
  created_at timestamptz not null default now(),
  -- A policy must say what it covers.
  constraint source_policies_has_scope check (
    domain is not null or url_pattern is not null or organization_id is not null or jurisdiction_id is not null
  ),
  -- An approval is a human act with a name and a time on it, or it is not one.
  constraint source_policies_approval_complete check (
    (production_approved_by is null) = (production_approved_at is null)
  ),
  -- Prohibited means prohibited. If the policy was read wrongly, correct the
  -- policy row, which leaves a trail; do not approve around it.
  constraint source_policies_prohibited_not_approved check (
    collection_status <> 'prohibited' or production_approved_by is null
  )
);

create index source_policies_domain_idx on source_policies (domain);
create index source_policies_status_idx on source_policies (collection_status);

create table directory_platforms (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  adapter_key text not null,
  adapter_version text not null,
  detection_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One retrieved source artefact: a page, an API response, a dataset, a
-- spreadsheet or a PDF.
create table source_documents (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  url_canonical text not null,
  url_hash text not null unique,
  domain text not null,
  source_type_code text not null references source_types (code),
  http_status integer,
  content_hash text,
  content_type text,
  storage_key text,
  robots_allowed boolean,
  robots_policy_note text,
  source_policy_id uuid references source_policies (id) on delete set null,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  retrieved_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index source_documents_domain_idx on source_documents (domain);
create index source_documents_crawl_run_idx on source_documents (crawl_run_id);
create index source_documents_type_idx on source_documents (source_type_code);

-- One observed field value in one document. Append-only evidence.
--
-- `evidence_class` separates what a source proves: a roster may establish
-- employment while a contact page supplies the address, and either can be
-- revised without disturbing the other.
create table source_observations (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references source_documents (id) on delete cascade,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  evidence_class text not null references evidence_classes (code),
  entity_type text not null,
  entity_id uuid,
  record_key text not null,
  field text not null,
  value_raw text,
  value_normalized text,
  extraction_method extraction_method not null,
  confidence numeric(4, 3) not null default 0,
  selector text,
  observed_at timestamptz not null default now(),
  constraint source_observations_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint source_observations_unique_field unique (source_document_id, record_key, field)
);

create index source_observations_entity_idx on source_observations (entity_type, entity_id);
create index source_observations_record_key_idx on source_observations (record_key);
create index source_observations_evidence_idx on source_observations (evidence_class);
