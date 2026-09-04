drop trigger if exists source_observations_append_only_trigger on source_observations;
create trigger source_observations_append_only_trigger
  before delete on source_observations
  for each row execute function source_observations_append_only();

drop table if exists organization_identity_evidence;

alter table exports
  drop constraint if exists exports_withheld_candidate_count_nonnegative,
  drop column if exists withheld_candidate_count;

alter table complaints
  drop constraint if exists complaints_resolution_consistent,
  drop constraint if exists complaints_idempotency_key_unique,
  drop column if exists created_by,
  drop column if exists contact_value_normalized,
  drop column if exists idempotency_key;

-- The older schema cannot retain an address-level suppression link on a
-- complaint that still needs a person. The immutable suppression itself stays.
update complaints
set suppression_entry_id = null
where resolution = 'needs_review' and suppression_entry_id is not null;

alter table complaints
  add constraint complaints_resolution_consistent check (
    (resolution = 'suppressed' and suppression_entry_id is not null)
    or (resolution = 'needs_review' and review_reason is not null and suppression_entry_id is null)
    or (resolution = 'pending' and suppression_entry_id is null)
    or (resolution = 'dismissed' and review_reason is not null)
  );

drop function if exists audit_event_append(text, text, text, uuid, jsonb, text, timestamptz);
drop function if exists audit_event_hash(text, bigint, timestamptz, text, text, text, text, uuid, jsonb);

alter table audit_events disable trigger audit_events_append_only_trigger;

alter table audit_events
  drop constraint if exists audit_events_sequence_unique,
  drop column if exists sequence_number,
  drop column if exists actor_type;

drop sequence if exists audit_event_sequence;

create function audit_event_hash(
  prev_hash text,
  actor text,
  action text,
  entity_type text,
  entity_id uuid,
  payload jsonb
) returns text as $$
  select encode(
    sha256(
      convert_to(
        coalesce(prev_hash, '') || '|' || actor || '|' || action || '|' || entity_type || '|'
          || coalesce(entity_id::text, '') || '|' || coalesce(payload, '{}'::jsonb)::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$ language sql immutable;

do $$
declare
  event record;
  previous_hash text := null;
  legacy_hash text;
begin
  for event in
    select id, actor, action, entity_type, entity_id, payload
    from audit_events order by occurred_at, id
  loop
    legacy_hash := audit_event_hash(
      previous_hash, event.actor, event.action, event.entity_type, event.entity_id, event.payload
    );
    update audit_events set prev_hash = previous_hash, hash = legacy_hash where id = event.id;
    previous_hash := legacy_hash;
  end loop;
end;
$$;

alter table audit_events enable trigger audit_events_append_only_trigger;

create function audit_event_append(
  p_actor text,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb
) returns uuid as $$
declare
  v_prev text;
  v_hash text;
  v_id uuid;
begin
  select hash into v_prev from audit_events order by occurred_at desc, id desc limit 1;
  v_hash := audit_event_hash(v_prev, p_actor, p_action, p_entity_type, p_entity_id, p_payload);
  insert into audit_events (actor, action, entity_type, entity_id, payload, prev_hash, hash)
  values (p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb), v_prev, v_hash)
  returning id into v_id;
  return v_id;
end;
$$ language plpgsql;

create or replace function suppression_entries_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'suppression_entries rows cannot be deleted; revoke them instead';
  end if;
  if row(new.scope, new.value, new.person_id, new.organization_id, new.jurisdiction_id,
         new.geographic_area_id, new.source_document_id, new.government_level_code,
         new.export_purpose, new.reason, new.source, new.effective_at, new.expires_at,
         new.created_by, new.created_at)
     is distinct from
     row(old.scope, old.value, old.person_id, old.organization_id, old.jurisdiction_id,
         old.geographic_area_id, old.source_document_id, old.government_level_code,
         old.export_purpose, old.reason, old.source, old.effective_at, old.expires_at,
         old.created_by, old.created_at) then
    raise exception 'suppression_entries rows are immutable except for revocation';
  end if;
  if old.revoked_at is not null then
    if new.revoked_at is null then
      raise exception 'a revoked suppression entry cannot be un-revoked';
    end if;
    if new.revoked_at is distinct from old.revoked_at then
      raise exception 'revoked_at cannot be changed once set';
    end if;
    if new.revoked_reason is distinct from old.revoked_reason then
      raise exception 'revoked_reason cannot be changed once set';
    end if;
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    if new.revoked_reason is null or new.revoked_reason = '' then
      raise exception 'a revocation must record why';
    end if;
    perform audit_event_append(
      coalesce(current_setting('app.actor', true), 'database'),
      'suppression.revoked',
      'suppression_entry',
      new.id,
      jsonb_build_object(
        'scope', new.scope,
        'revokedAt', new.revoked_at,
        'revokedReason', new.revoked_reason
      )
    );
  end if;
  return new;
end;
$$ language plpgsql;
