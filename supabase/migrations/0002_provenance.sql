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

-- One source artefact, identified by where it lives.
--
-- The document is the stable thing: a URL, a dataset, a spreadsheet. What that
-- URL said on a given day is a version, and versions live in their own table.
-- Keeping them apart is what makes evidence append-only. A single row per URL
-- would mean a recrawl overwriting `content_hash`, and with it the record of
-- what the page used to say, which is exactly what a disputed record needs.
create table source_documents (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  url_canonical text not null,
  url_hash text not null unique,
  domain text not null,
  source_type_code text not null references source_types (code),
  source_policy_id uuid references source_policies (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index source_documents_domain_idx on source_documents (domain);
create index source_documents_type_idx on source_documents (source_type_code);

-- What one document said, once. Immutable.
--
-- A new content hash appends a version; identical content matches the existing
-- one and only moves `last_seen_at`, which is what makes a recrawl idempotent
-- without making it forgetful. Nothing here may be rewritten, so a value that
-- was published in March is still readable after the page changes in June.
create table source_document_versions (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references source_documents (id) on delete restrict,
  version integer not null,
  content_hash text not null,
  http_status integer,
  content_type text,
  storage_key text,
  robots_allowed boolean,
  robots_policy_note text,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  retrieved_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint source_document_versions_version_positive check (version >= 1),
  -- The same bytes are the same version, however many times they are fetched.
  constraint source_document_versions_content unique (source_document_id, content_hash),
  constraint source_document_versions_ordinal unique (source_document_id, version)
);

create index source_document_versions_document_idx
  on source_document_versions (source_document_id, version desc);
create index source_document_versions_crawl_run_idx on source_document_versions (crawl_run_id);

-- Everything except the last-seen window is fixed once written.
create or replace function source_document_versions_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'source document versions cannot be deleted; evidence is append-only';
  end if;
  if row(new.source_document_id, new.version, new.content_hash, new.http_status,
         new.content_type, new.storage_key, new.crawl_run_id, new.retrieved_at,
         new.first_seen_at)
     is distinct from
     row(old.source_document_id, old.version, old.content_hash, old.http_status,
         old.content_type, old.storage_key, old.crawl_run_id, old.retrieved_at,
         old.first_seen_at) then
    raise exception 'source document versions are immutable except for last_seen_at';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_document_versions_immutable_trigger
  before update or delete on source_document_versions
  for each row execute function source_document_versions_immutable();

-- One observed field value in one document version. Append-only evidence.
--
-- `evidence_class` separates what a source proves: a roster may establish
-- employment while a contact page supplies the address, and either can be
-- revised without disturbing the other.
--
-- The uniqueness key names the version, not the document, so a page that
-- changes its mind about someone's title produces a second observation beside
-- the first rather than replacing it.
create table source_observations (
  id uuid primary key default gen_random_uuid(),
  source_document_version_id uuid not null
    references source_document_versions (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  evidence_class text not null references evidence_classes (code),
  entity_type text not null,
  entity_id uuid,
  record_key text not null,
  field text not null,
  value_raw text,
  value_normalized text,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  selector text,
  observed_at timestamptz not null default now(),
  constraint source_observations_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint source_observations_unique_field
    unique (source_document_version_id, record_key, field)
);

create or replace function source_observations_append_only() returns trigger as $$
begin
  raise exception 'source_observations is append-only; a changed value is a new observation';
end;
$$ language plpgsql;

create trigger source_observations_append_only_trigger
  before delete on source_observations
  for each row execute function source_observations_append_only();

create index source_observations_entity_idx on source_observations (entity_type, entity_id);
create index source_observations_record_key_idx on source_observations (record_key);
create index source_observations_evidence_idx on source_observations (evidence_class);
