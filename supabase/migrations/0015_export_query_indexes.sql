-- Export reads resolve a published address per person. PostgreSQL does not
-- create an index for a foreign key automatically, and the missing lookup
-- turned a national-size export into one full email-table scan per person.

create index email_addresses_person_idx on email_addresses (person_id);
create index suppression_geographic_area_idx
  on suppression_entries (geographic_area_id) where revoked_at is null;
create index suppression_source_document_idx
  on suppression_entries (source_document_id) where revoked_at is null;
create index suppression_government_level_idx
  on suppression_entries (government_level_code) where revoked_at is null;
create index suppression_export_purpose_idx
  on suppression_entries (export_purpose) where revoked_at is null;
