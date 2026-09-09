-- One finite authorization may cover discovery and its resulting directories.
alter table collection_batches add column collect_discovered boolean not null default false;
alter table collection_batches add column expires_at timestamptz;
alter table collection_batches drop constraint collection_batches_limits_positive;
alter table collection_batches add constraint collection_batches_limits_positive check (
  target_limit between 1 and 1000000 and page_limit > 0 and error_limit > 0
);
alter table collection_jobs add column discovery_state jsonb;
alter table collection_jobs add column outcome_detail text;

create table collection_batch_organizations (
  batch_id uuid not null references collection_batches(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete restrict,
  primary key (batch_id, organization_id)
);
alter table collection_batch_organizations enable row level security;
alter table collection_batch_organizations force row level security;

-- Identity and published websites can be known while government level is not.
alter table organizations alter column government_level_code drop not null;

create table crawl_target_organizations (
  crawl_target_id uuid not null references crawl_targets(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete restrict,
  source_document_id uuid not null references source_documents(id) on delete restrict,
  constraint crawl_target_organizations_has_provenance check (source_document_id is not null),
  primary key (crawl_target_id, organization_id)
);
insert into crawl_target_organizations
select t.id, o.id, o.source_document_id from crawl_targets t join organizations o on o.id=t.organization_id;
alter table crawl_target_organizations enable row level security;
alter table crawl_target_organizations force row level security;

do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on collection_batch_organizations, crawl_target_organizations from %I', role_name);
    end if;
  end loop;
end;
$$;

alter table collection_jobs drop constraint collection_jobs_target_once_per_batch;
alter table collection_jobs add constraint collection_jobs_target_once_per_batch unique(batch_id,crawl_target_id,kind);

alter table employment_assignments add column created_at timestamptz not null default now();

create index crawl_target_organizations_org_idx on crawl_target_organizations(organization_id,crawl_target_id);
