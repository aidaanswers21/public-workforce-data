-- Observed addresses and inferred guesses live in different tables.
--
-- This is the structural guarantee behind "never overwrite a published email
-- with an inferred value": there is no row shape that can hold an inferred
-- address in email_addresses, so no bug in application code can put one there.

create table email_addresses (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people (id) on delete cascade,
  employment_assignment_id uuid references employment_assignments (id) on delete set null,
  organization_id uuid references organizations (id) on delete set null,
  address text not null,
  address_normalized text not null,
  domain text not null,
  local_part text not null,
  classification email_classification not null,
  obfuscation_kind_code text not null default 'none' references obfuscation_kinds (code),
  source_value text,
  validation_status email_validation_status not null default 'unvalidated',
  latest_validation_result_id uuid,
  status record_status not null default 'active',
  source_document_id uuid not null references source_documents (id) on delete restrict,
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  extraction_method_code text not null references extraction_methods (code),
  confidence numeric(4, 3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint email_addresses_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint email_addresses_has_provenance check (source_document_id is not null),
  -- Only classes a source actually displayed. Inferred addresses belong in
  -- email_candidates; 'suppressed' is an overlay computed at query time.
  constraint email_addresses_observed_only check (
    classification in ('published', 'decoded_published', 'general_inbox', 'invalid')
  ),
  constraint email_addresses_unique unique nulls not distinct (
    person_id, organization_id, address_normalized
  )
);

create index email_addresses_domain_idx on email_addresses (domain);
create index email_addresses_normalized_idx on email_addresses (address_normalized);
create index email_addresses_classification_idx on email_addresses (classification);
create index email_addresses_organization_idx on email_addresses (organization_id);

create table email_candidates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people (id) on delete cascade,
  employment_assignment_id uuid references employment_assignments (id) on delete set null,
  organization_id uuid references organizations (id) on delete set null,
  domain text not null,
  address text not null,
  pattern text not null,
  supporting_examples jsonb not null default '[]'::jsonb,
  support_count integer not null default 0,
  conflict_count integer not null default 0,
  consistency numeric(4, 3) not null default 0,
  -- Confidence in the inference, in a separate column from validation_status so
  -- "we think this is the pattern" can never be read as "a provider confirmed
  -- this mailbox".
  confidence numeric(4, 3) not null default 0,
  state email_candidate_state not null default 'pending',
  validation_status email_validation_status not null default 'unvalidated',
  latest_validation_result_id uuid,
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_candidates_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint email_candidates_consistency_range check (consistency >= 0 and consistency <= 1),
  constraint email_candidates_support_positive check (support_count >= 0 and conflict_count >= 0),
  -- A candidate is only "promoted" once a provider has actually returned valid.
  constraint email_candidates_promotion_requires_validation check (
    state <> 'promoted' or (validation_status = 'valid' and promoted_at is not null)
  ),
  constraint email_candidates_unique unique (person_id, address)
);

create index email_candidates_state_idx on email_candidates (state);
create index email_candidates_domain_idx on email_candidates (domain);

create table email_validation_results (
  id uuid primary key default gen_random_uuid(),
  email_address_id uuid references email_addresses (id) on delete cascade,
  email_candidate_id uuid references email_candidates (id) on delete cascade,
  provider text not null,
  provider_request_id text,
  status email_validation_status not null,
  sub_status text,
  score numeric(4, 3),
  raw jsonb not null default '{}'::jsonb,
  validated_at timestamptz not null default now(),
  constraint email_validation_results_target check (
    (email_address_id is not null) <> (email_candidate_id is not null)
  ),
  constraint email_validation_results_score_range check (score is null or (score >= 0 and score <= 1))
);

create index email_validation_results_address_idx on email_validation_results (email_address_id);
create index email_validation_results_candidate_idx on email_validation_results (email_candidate_id);

alter table email_addresses add constraint email_addresses_validation_fk
  foreign key (latest_validation_result_id) references email_validation_results (id) on delete set null;
alter table email_candidates add constraint email_candidates_validation_fk
  foreign key (latest_validation_result_id) references email_validation_results (id) on delete set null;

-- Domain patterns learned from published addresses, kept so an inference can
-- always be re-derived and audited rather than trusted.
create table domain_email_patterns (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  pattern text not null,
  supporting_examples jsonb not null default '[]'::jsonb,
  support_count integer not null default 0,
  conflict_count integer not null default 0,
  consistency numeric(4, 3) not null default 0,
  learned_at timestamptz not null default now(),
  crawl_run_id uuid references crawl_runs (id) on delete set null,
  constraint domain_email_patterns_unique unique (domain, pattern)
);
