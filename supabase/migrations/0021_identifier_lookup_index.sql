-- Parent resolution knows the identifier system and value before it compares
-- nullable issuing jurisdictions. Keep both equality columns at the front so
-- each parent lookup does not scan the entire identifier table.
create index external_identifiers_system_value_idx
  on external_identifiers (identifier_system_code, identifier_value, issuing_state_code);
