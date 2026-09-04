-- Containment must remain a directed acyclic graph. Serializing application
-- writes makes the check reliable when two workers observe hierarchy at once.

create or replace function organization_relationships_reject_cycle() returns trigger as $$
declare
  containment boolean;
  creates_cycle boolean;
begin
  perform pg_advisory_xact_lock(734878942635191127);

  select implies_subtree into containment
  from relationship_types
  where code = new.relationship_type_code;
  if not coalesce(containment, false) then
    return new;
  end if;

  with recursive descendants as (
    select
      r.child_organization_id as organization_id,
      greatest(new.effective_from, r.effective_from) as overlap_from,
      least(
        coalesce(new.effective_to, 'infinity'::date),
        coalesce(r.effective_to, 'infinity'::date)
      ) as overlap_to,
      array[new.child_organization_id, r.child_organization_id]::uuid[] as visited
    from organization_relationships r
    join relationship_types rt
      on rt.code = r.relationship_type_code and rt.implies_subtree
    where r.parent_organization_id = new.child_organization_id
      and r.id <> new.id
      and greatest(new.effective_from, r.effective_from) <= least(
        coalesce(new.effective_to, 'infinity'::date),
        coalesce(r.effective_to, 'infinity'::date)
      )

    union all

    select
      r.child_organization_id,
      greatest(d.overlap_from, r.effective_from),
      least(d.overlap_to, coalesce(r.effective_to, 'infinity'::date)),
      d.visited || r.child_organization_id
    from descendants d
    join organization_relationships r on r.parent_organization_id = d.organization_id
    join relationship_types rt
      on rt.code = r.relationship_type_code and rt.implies_subtree
    where r.id <> new.id
      and not r.child_organization_id = any(d.visited)
      and greatest(d.overlap_from, r.effective_from)
          <= least(d.overlap_to, coalesce(r.effective_to, 'infinity'::date))
  )
  select exists (
    select 1 from descendants
    where organization_id = new.parent_organization_id
      and overlap_from <= overlap_to
  ) into creates_cycle;

  if creates_cycle then
    raise exception 'containment relationship would create a cycle';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger organization_relationships_cycle_guard
  before insert or update of parent_organization_id, child_organization_id,
    relationship_type_code, effective_from, effective_to
  on organization_relationships
  for each row execute function organization_relationships_reject_cycle();
