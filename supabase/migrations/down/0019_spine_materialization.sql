update organizations organization
set identity_fingerprint =
  'oid:' || identifier.identifier_system_code || ':' || identifier.identifier_value
from external_identifiers identifier
where identifier.entity_type = 'organization'
  and identifier.entity_id = organization.id
  and identifier.is_primary
  and identifier.issuing_state_code is not null
  and organization.identity_fingerprint =
    'oid:' || identifier.identifier_system_code || ':' ||
    identifier.issuing_state_code || ':' || identifier.identifier_value;

alter table external_identifiers
  drop constraint external_identifiers_unique;

alter table external_identifiers
  add constraint external_identifiers_unique unique (
    identifier_system_code, identifier_value
  );

drop index organization_spine_records_jurisdiction_idx;

alter table organization_spine_records
  drop column website_value_raw,
  drop column jurisdiction_id;
