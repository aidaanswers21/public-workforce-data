-- Make jurisdiction-scoped bulk records canonicalizable without weakening exact-ID identity.

alter table organization_spine_records
  add column jurisdiction_id uuid references jurisdictions (id) on delete set null,
  add column website_value_raw text;

create index organization_spine_records_jurisdiction_idx
  on organization_spine_records (jurisdiction_id, status);

-- State-issued identifiers are unique inside the issuing state, not nationally.
alter table external_identifiers
  drop constraint external_identifiers_unique;

alter table external_identifiers
  add constraint external_identifiers_unique unique nulls not distinct (
    identifier_system_code, issuing_state_code, identifier_value
  );

-- Keep existing canonical fingerprints aligned with the scoped identity rule.
update organizations organization
set identity_fingerprint =
  'oid:' || identifier.identifier_system_code || ':' ||
  identifier.issuing_state_code || ':' || identifier.identifier_value
from external_identifiers identifier
where identifier.entity_type = 'organization'
  and identifier.entity_id = organization.id
  and identifier.is_primary
  and identifier.issuing_state_code is not null
  and organization.identity_fingerprint =
    'oid:' || identifier.identifier_system_code || ':' || identifier.identifier_value;
