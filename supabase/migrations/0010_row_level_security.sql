-- Row level security, default deny, on every table in the public schema.
--
-- Supabase exposes the public schema through PostgREST. Anything reachable
-- there is reachable by anyone holding the project's publishable key, which is
-- a value that ships in client code. This platform holds public employees' work
-- contact details, an opt-out list and an audit trail, and none of that is
-- something an anonymous browser request should be able to read.
--
-- The rule is the absence of a rule. Enabling row level security with no policy
-- denies everything to `anon` and `authenticated`, and the service role bypasses
-- row level security by design. So the pipeline, which connects with the service
-- role or over a direct database connection, is unaffected, and PostgREST
-- returns nothing to anyone else.
--
-- There are deliberately NO permissive policies here. A placeholder policy that
-- allows a read "for now" is worse than no security at all, because it looks
-- like a considered decision. When a route genuinely needs anonymous access, it
-- gets its own migration, its own policy, and a person's name on the review.
--
-- FORCE is set as well as ENABLE. Without it, the table owner bypasses row
-- level security, and in a Supabase project the owner is a role that migrations
-- and some tooling run as.

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
    execute format('alter table public.%I enable row level security', target.relname);
    execute format('alter table public.%I force row level security', target.relname);
  end loop;
end;
$$;

-- Revoke the default grants PostgREST's roles inherit, so a future policy is
-- the only thing that can ever open a table rather than a leftover grant. New
-- tables inherit the same posture, because a table added by a later migration
-- would otherwise be exposed the moment it exists.
--
-- The roles are created by Supabase and do not exist in the in-process
-- PostgreSQL the tests run against, so each is guarded. A missing role is not a
-- silent skip of the security model: row level security above is already
-- enabled and forced on every table, and with no policies that denies everyone
-- regardless of grants. These statements remove the redundant grant as well.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on all tables in schema public from %I', role_name);
      execute format('revoke all on all sequences in schema public from %I', role_name);
      execute format('revoke all on all functions in schema public from %I', role_name);
      execute format(
        'alter default privileges in schema public revoke all on tables from %I', role_name
      );
      execute format(
        'alter default privileges in schema public revoke all on sequences from %I', role_name
      );
      execute format(
        'alter default privileges in schema public revoke all on functions from %I', role_name
      );
    end if;
  end loop;
end;
$$;
