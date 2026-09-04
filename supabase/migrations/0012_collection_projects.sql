-- Operator-defined collection scopes and the durable, finite work they release.

create type collection_project_status as enum (
  'draft', 'active', 'paused', 'completed', 'cancelled'
);

create type collection_batch_status as enum (
  'awaiting_approval', 'queued', 'running', 'completed', 'completed_with_errors', 'cancelled'
);

create type collection_job_status as enum (
  'queued', 'claimed', 'running', 'completed', 'failed', 'policy_hold', 'cancelled'
);

create type collection_job_kind as enum ('discovery', 'crawl');

create table collection_projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  jurisdiction_config_key text not null,
  jurisdiction_id uuid references jurisdictions (id) on delete set null,
  state_code char(2),
  sector_codes text[] not null,
  government_level_codes text[] not null,
  filters jsonb not null default '{}'::jsonb,
  estimated_organization_count integer,
  batch_size integer not null default 10,
  max_pages_per_target integer not null default 10,
  max_pages_per_batch integer not null default 100,
  max_errors_per_batch integer not null default 3,
  status collection_project_status not null default 'draft',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collection_projects_name_present check (length(trim(name)) > 0),
  constraint collection_projects_sector_present check (cardinality(sector_codes) > 0),
  constraint collection_projects_level_present check (cardinality(government_level_codes) > 0),
  constraint collection_projects_estimate_nonnegative check (
    estimated_organization_count is null or estimated_organization_count >= 0
  ),
  constraint collection_projects_budgets_positive check (
    batch_size between 1 and 1000
    and max_pages_per_target between 1 and 1000
    and max_pages_per_batch between 1 and 100000
    and max_errors_per_batch between 1 and 1000
  )
);

create index collection_projects_status_idx on collection_projects (status, updated_at desc);
create index collection_projects_jurisdiction_idx on collection_projects (jurisdiction_id);

-- A materialized, reviewable scope. Refreshing it never silently removes rows
-- that already belong to an approved batch.
create table collection_project_organizations (
  project_id uuid not null references collection_projects (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete restrict,
  selection_reason text not null,
  included_at timestamptz not null default now(),
  primary key (project_id, organization_id)
);

create index collection_project_organizations_org_idx
  on collection_project_organizations (organization_id);

-- Approval is attached to one finite batch, not to the project forever. A
-- queued batch must identify the person who approved that exact release.
create table collection_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references collection_projects (id) on delete cascade,
  sequence_number integer not null,
  kind collection_job_kind not null,
  status collection_batch_status not null default 'awaiting_approval',
  target_limit integer not null,
  page_limit integer not null,
  error_limit integer not null,
  pages_processed integer not null default 0,
  errors_encountered integer not null default 0,
  approved_by text,
  approved_at timestamptz,
  approval_note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint collection_batches_sequence_unique unique (project_id, sequence_number),
  constraint collection_batches_limits_positive check (
    target_limit between 1 and 1000 and page_limit > 0 and error_limit > 0
  ),
  constraint collection_batches_approval_complete check (
    (approved_by is null) = (approved_at is null)
    and (approved_by is null) = (approval_note is null)
  ),
  constraint collection_batches_queued_requires_approval check (
    status = 'awaiting_approval' or approved_by is not null
  ),
  constraint collection_batches_finished_after_started check (
    finished_at is null or started_at is null or finished_at >= started_at
  )
);

create index collection_batches_project_idx
  on collection_batches (project_id, sequence_number desc);
create index collection_batches_status_idx on collection_batches (status, created_at);

create table collection_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references collection_projects (id) on delete cascade,
  batch_id uuid not null references collection_batches (id) on delete cascade,
  crawl_target_id uuid not null references crawl_targets (id) on delete restrict,
  domain_key text not null,
  kind collection_job_kind not null,
  status collection_job_status not null default 'queued',
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 2,
  claimed_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  pages_processed integer not null default 0,
  records_collected integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint collection_jobs_target_once_per_batch unique (batch_id, crawl_target_id),
  constraint collection_jobs_attempts_valid check (
    attempt_count >= 0 and max_attempts between 1 and 10 and attempt_count <= max_attempts
  ),
  constraint collection_jobs_counts_nonnegative check (
    pages_processed >= 0 and records_collected >= 0
  ),
  constraint collection_jobs_claim_complete check (
    (status in ('claimed', 'running') and claimed_by is not null
      and claim_token is not null and lease_expires_at is not null)
    or status not in ('claimed', 'running')
  ),
  constraint collection_jobs_finished_after_started check (
    finished_at is null or started_at is null or finished_at >= started_at
  )
);

create index collection_jobs_claim_idx
  on collection_jobs (status, priority, created_at)
  where status in ('queued', 'claimed', 'running');
create index collection_jobs_project_idx on collection_jobs (project_id, status);
create index collection_jobs_batch_idx on collection_jobs (batch_id, status);
-- One active lease per registrable domain across every worker process.
create unique index collection_jobs_one_active_domain_idx
  on collection_jobs (domain_key)
  where status in ('claimed', 'running');

-- Migration 0010 set the default-deny posture for all tables that existed then.
-- These later tables receive the same posture explicitly.
alter table collection_projects enable row level security;
alter table collection_projects force row level security;
alter table collection_project_organizations enable row level security;
alter table collection_project_organizations force row level security;
alter table collection_batches enable row level security;
alter table collection_batches force row level security;
alter table collection_jobs enable row level security;
alter table collection_jobs force row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on collection_projects from %I', role_name);
      execute format('revoke all on collection_project_organizations from %I', role_name);
      execute format('revoke all on collection_batches from %I', role_name);
      execute format('revoke all on collection_jobs from %I', role_name);
    end if;
  end loop;
end;
$$;
