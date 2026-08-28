-- Provenance comes first: every institution, person and address references a
-- source page, so the evidence tables must exist before the records they justify.

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

create table crawl_runs (
  id uuid primary key default gen_random_uuid(),
  state_id uuid,
  run_type text not null,
  status crawl_run_status not null default 'queued',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  initiated_by text not null,
  constraint crawl_runs_finished_after_started check (finished_at is null or finished_at >= started_at)
);

create index crawl_runs_state_started_idx on crawl_runs (state_id, started_at desc);

create table source_pages (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  url_canonical text not null,
  url_hash text not null unique,
  domain text not null,
  source_type source_type not null,
  http_status integer,
  content_hash text,
  content_type text,
  storage_key text,
  robots_allowed boolean,
  robots_policy_note text,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  fetched_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index source_pages_domain_idx on source_pages (domain);
create index source_pages_crawl_run_idx on source_pages (crawl_run_id);

-- One observed field value on one page. Append-only evidence: nothing in this
-- table is ever updated, so a normalized record can always be traced back to
-- the exact string a page published and the moment it was read.
create table source_observations (
  id uuid primary key default gen_random_uuid(),
  source_page_id uuid not null references source_pages (id) on delete cascade,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
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
  constraint source_observations_unique_field unique (source_page_id, record_key, field)
);

create index source_observations_entity_idx on source_observations (entity_type, entity_id);
create index source_observations_record_key_idx on source_observations (record_key);
