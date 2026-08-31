-- Reverses the row level security posture.
--
-- A test utility, not an operational step. Turning row level security off in a
-- deployed project would expose every table, so this exists to let the
-- migration test roll the schema down and back up, and for nothing else.
do $$
declare
  target record;
begin
  for target in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
  loop
    execute format('alter table public.%I no force row level security', target.relname);
    execute format('alter table public.%I disable row level security', target.relname);
  end loop;
end;
$$;
