-- Evidence-backed website resolution for organizations whose official source
-- did not publish a website.

create type organization_website_candidate_status as enum (
  'proposed', 'verified', 'rejected', 'superseded'
);

create type website_resolution_method as enum (
  'official_identifier_overlay',
  'official_registry_match',
  'official_directory_match',
  'search_result',
  'homepage_redirect',
  'manual'
);

alter table source_document_versions
  add constraint source_document_versions_id_document_unique
  unique (id, source_document_id);

create table organization_website_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  url text not null,
  primary_domain text not null,
  resolution_method website_resolution_method not null,
  status organization_website_candidate_status not null default 'proposed',
  match_signals jsonb not null default '{}'::jsonb,
  confidence numeric(4, 3) not null,
  source_document_id uuid not null references source_documents (id) on delete restrict,
  source_document_version_id uuid not null,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint organization_website_candidates_unique unique (organization_id, url),
  constraint organization_website_candidates_confidence_range
    check (confidence >= 0 and confidence <= 1),
  constraint organization_website_candidates_has_provenance
    check (source_document_id is not null and source_document_version_id is not null),
  constraint organization_website_candidates_version_provenance foreign key (
    source_document_version_id, source_document_id
  ) references source_document_versions (id, source_document_id) on delete restrict,
  constraint organization_website_candidates_review_complete check (
    (reviewed_by is null) = (reviewed_at is null)
    and (reviewed_by is null) = (review_note is null)
    and (
      status = 'proposed'
      or (reviewed_by is not null and status in ('verified', 'rejected', 'superseded'))
    )
  )
);

create index organization_website_candidates_review_idx
  on organization_website_candidates (status, confidence desc, first_seen_at)
  where status = 'proposed';
create index organization_website_candidates_organization_idx
  on organization_website_candidates (organization_id, status);
create index organizations_missing_website_idx
  on organizations (government_level_code, sector_code, id)
  where website_url is null and status = 'active';

alter table organization_website_candidates enable row level security;
alter table organization_website_candidates force row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on organization_website_candidates from %I', role_name);
    end if;
  end loop;
end;
$$;
