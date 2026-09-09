-- Refuse rollback if newly supported unknown classifications still exist.
alter table organizations alter column government_level_code set not null;
drop table crawl_target_organizations;
drop table collection_batch_organizations;
alter table collection_jobs drop column outcome_detail;
alter table collection_jobs drop column discovery_state;
alter table collection_batches drop column expires_at;
alter table collection_batches drop column collect_discovered;
alter table collection_batches drop constraint collection_batches_limits_positive;
alter table collection_batches add constraint collection_batches_limits_positive check (
  target_limit between 1 and 1000 and page_limit > 0 and error_limit > 0
);

alter table collection_jobs drop constraint collection_jobs_target_once_per_batch;
alter table collection_jobs add constraint collection_jobs_target_once_per_batch unique(batch_id,crawl_target_id);

alter table employment_assignments drop column created_at;
