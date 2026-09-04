alter table if exists email_candidates drop constraint if exists email_candidates_validation_fk;
alter table if exists email_addresses drop constraint if exists email_addresses_validation_fk;
drop table if exists domain_email_patterns;
drop table if exists email_validation_results;
drop table if exists email_candidates;
drop table if exists email_addresses;
