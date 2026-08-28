create table crawl_targets (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references states (id) on delete cascade,
  district_id uuid references districts (id) on delete cascade,
  school_id uuid references schools (id) on delete cascade,
  url text not null,
  url_hash text not null,
  target_type crawl_target_type not null,
  source_type source_type not null,
  directory_platform_id uuid references directory_platforms (id) on delete set null,
  adapter_key text,
  status crawl_target_status not null default 'pending',
  priority integer not null default 100,
  exclusion_reason text,
  last_crawled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crawl_targets_unique_url unique (state_id, url_hash)
);

create index crawl_targets_status_idx on crawl_targets (status, priority);
create index crawl_targets_district_idx on crawl_targets (district_id);

create table crawl_pages (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references crawl_runs (id) on delete cascade,
  crawl_target_id uuid references crawl_targets (id) on delete set null,
  url text not null,
  url_hash text not null,
  status crawl_page_status not null default 'pending',
  http_status integer,
  depth integer not null default 0,
  pagination_token text,
  records_extracted integer not null default 0,
  content_hash text,
  duration_ms integer,
  fetched_at timestamptz,
  -- One row per url per run. Re-running a crawl updates this row rather than
  -- adding another, which is what makes a recrawl idempotent at the page level.
  constraint crawl_pages_unique_per_run unique (crawl_run_id, url_hash)
);

create index crawl_pages_run_status_idx on crawl_pages (crawl_run_id, status);

create table crawl_errors (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references crawl_runs (id) on delete cascade,
  crawl_target_id uuid references crawl_targets (id) on delete set null,
  url text,
  error_type crawl_error_type not null,
  message text not null,
  retryable boolean not null default false,
  attempt integer not null default 1,
  occurred_at timestamptz not null default now()
);

create index crawl_errors_run_idx on crawl_errors (crawl_run_id, error_type);

-- Resume points, one per target per run.
create table crawl_checkpoints (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references crawl_runs (id) on delete cascade,
  crawl_target_id uuid references crawl_targets (id) on delete cascade,
  payload jsonb not null,
  pages_fetched integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint crawl_checkpoints_unique unique nulls not distinct (crawl_run_id, crawl_target_id)
);
