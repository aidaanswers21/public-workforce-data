drop trigger if exists audit_events_append_only_trigger on audit_events;
drop function if exists audit_events_append_only();
drop table if exists audit_events;
drop table if exists exports;
drop table if exists complaints;
drop trigger if exists suppression_entries_immutable_trigger on suppression_entries;
drop function if exists suppression_entries_immutable();
drop table if exists suppression_entries;
