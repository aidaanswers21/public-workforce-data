drop table if exists external_identifiers;
drop table if exists organization_locations;
drop table if exists organizational_units;
drop table if exists organization_relationships;
alter table if exists source_policies drop constraint if exists source_policies_jurisdiction_fk;
alter table if exists source_policies drop constraint if exists source_policies_organization_fk;
drop table if exists organizations;
