# Architecture

## What this is

An internal data platform that collects publicly displayed U.S. public-sector
organization and employee directory information across six levels of government,
normalizes it, and stores it with complete source provenance. It collects and
manages data. It does not send outreach of any kind, and there is no code path in
this repository that sends an email.

## Shape

```
apps/admin           private local or hosted console for inspection and project control
apps/api             authenticated, read-only HTTP API over coverage and records

services/
  crawler-worker     fetchers, ingestion, approved-batch worker, fixture crawl CLI
  discovery-worker   finds an organization's directory and records a target
  validation-worker  candidate generation and validation-provider driving

packages/
  shared-types       closed enums, entities, and the adapter contract
  taxonomy           controlled reference data, title rules, directory vocabulary
  core               normalization, email logic, dedup, suppression, source policy,
                     the data boundary, the crawl engine, export
  extraction         cheerio-based HTML and structured-data helpers
  database           migrations, repositories, reference seeding, the Postgres client
  directory-adapters kit (contract, registry, contract tests) plus per-platform adapters
  sectors            education, state-local-government, federal-government
  jurisdiction-config kit (types, registry, importer) plus per-jurisdiction configuration
  observability      structured JSON logging and run metrics

supabase/migrations  the schema, with a down script for every migration
tests/fixtures       saved pages and API responses; no test touches the network
```

## The neutral core

Everything above except `packages/sectors`, `packages/jurisdiction-config/<key>`
and the platform adapters is **neutral**: it knows about organizations,
relationships, jurisdictions, geographic areas, people, assignments, contact
points, evidence and suppression, and it knows nothing about schools, states or
directory vendors.

That is not a convention. `tests/neutral-core-guard.test.ts` reads every neutral
source file, strips comments and strings, and fails on any education term,
directory platform vendor or state name in executable code, and on any import of
a sector or jurisdiction package. Documentation examples in comments are
permitted; branching on a vertical is not.

Two files are exempt by path, each argued rather than assumed.
`packages/taxonomy/src/reference/domains.ts` lists the DNS labels published
under `.us` so the crawler can tell `co.harris.tx.us` from `ci.austin.tx.us`;
the test asserts it holds no imports, no functions and no branching.
`packages/core/src/policy/data-boundary.ts` names `student` and `pupil` in order
to refuse them, which is the opposite of vertical logic, and the test strips its
prohibition patterns and asserts no education term remains anywhere else.

## The four seams that make this extensible

**Directory adapters.** `DirectoryAdapter` in `@public-workforce/shared-types` is the whole
contract: detect, discover, extract a listing, extract a profile, discover
pagination. Adding a platform is a new class plus one `register` call in
`services/crawler-worker/src/registries.ts`. See `DIRECTORY_ADAPTERS.md`.

**Sector packs.** `SectorPack` in `@public-workforce/taxonomy` contributes
organization types, identifier systems, job families, role categories, title
rules, specialty patterns and directory vocabulary, and declares an `appliesTo`
scope saying whose records its rules may classify. `Taxonomy` composes the base
with every registered pack, refuses any collision that is not an explicit
`overrides` entry, and calls `assertCoherent()`. No migration is needed, because
these are reference rows and not enum values. See `SECTOR_EXTENSIONS.md`.

**Jurisdiction configuration.** `JurisdictionConfig` in `@public-workforce/jurisdiction-kit`
holds a government level, the sectors in play, official sources, column
mappings, identifier mappings, area aliases, seeds and crawl tuning. A
jurisdiction is a state, a county, a city, a special district or the federal
government, so `state-config` is deliberately not the abstraction: the federal
government is not a state. Government level and sector are separate fields on
the configuration, because they are separate facts. `validateJurisdictionConfig` reports an error if a
federal configuration names a state as an organizational parent. See
`ONBOARDING_STATE_LOCAL.md` and `ONBOARDING_FEDERAL.md`.

**Sector attribute tables.** An extension that needs attributes the neutral
organization core should not carry gets its own table, guarded by a trigger to
its own sector. `education_organization_attributes` is the worked example. See
`EDUCATION_IN_THE_PLATFORM.md`.

`tests/extensibility.test.ts` asserts all four properties directly rather than
leaving them as claims. It builds ten public-sector constructions inside the
test file and runs each through unmodified neutral core.

## Why the crawl engine is ours

`CrawlEngine` in `@public-workforce/core` owns everything that must not vary by platform or
vertical: source-policy gating, budgets, per-domain rate limiting, robots,
retries, cross-domain refusal, URL exclusion, loop protection, empty-success
detection and checkpointing. Adapters answer only "what is on this page" and
"where is the next one", using the vocabulary the taxonomy hands them.

That split is the reason the engine is not built on a crawling framework. The
framework features we would use, a request queue and a scheduler, are the ones
we had to own anyway to get per-target resumability tied to our own database.
The features we would not use, session pools and proxy rotation, exist to avoid
being detected, and this platform does the opposite: a source that blocks us is
recorded and left alone.

The transport sits behind the `Fetcher` port, so this decision is reversible in
one file. `HttpFetcher` uses Node 22's built-in fetch. `FixtureFetcher` serves
saved files and is what every test and `pnpm crawl:fixture` run against, which
is why no test can accidentally reach a real site.

Browser rendering is not implemented. `DirectoryAdapter.requiresBrowser` is the
seam it would arrive behind, and it is in `BACKLOG.md`.

## Data flow

```
official file        ->  importer          ->  organizations, relationships, areas
operator scope       ->  collection project -> selected organizations
explicit approval    ->  finite batch       -> leased collection_jobs
organization website ->  discovery-worker  ->  crawl_targets
source policy        ->  SourcePolicyGate  ->  allowed, or refused and recorded
crawl target         ->  CrawlEngine       ->  boundary-safe records + observed response metadata
                                               + documents + errors
fetched document     ->  version appender  ->  a new source_document_version only
                                               when the content hash changed
harvested records    ->  data boundary     ->  sanitized values and opaque checkpoint keys
sanitized records    ->  IngestionPipeline ->  source_observations (evidence-classed,
                                               keyed to the document version),
                                               people, employment_assignments,
                                               contact_points, email_addresses
published addresses  ->  CandidateGenerator->  email_candidates (separate pass)
candidates           ->  ValidationRunner  ->  email_validation_results
records              ->  ExportRepository  ->  CSV, suppression enforced twice
```

The scheduler is intentionally split into three durable layers. A project
records scope and safety limits. `collection_project_organizations` materializes
the organizations that matched those filters. A batch releases at most the
approved target count and records the approving operator and note. Workers claim
one job through an expiring database lease. A partial unique index permits only
one claimed or running job per registrable domain across every worker process.
Creating a project or generating targets performs no network request.

National-scale query measurements and their exact dataset shape are recorded in
`BENCHMARKS.md`.

## Invariants the code cannot violate

These are enforced by the schema, not by convention. See `DATA_MODEL.md`.

- An inferred address cannot be stored in `email_addresses`. A CHECK constraint
  restricts that table to classes a source actually displayed.
- An organization, relationship, unit, location, identifier, person, assignment,
  contact point, address or education attribute cannot exist without provenance.
  It is a NOT NULL foreign key to `source_documents` with `on delete restrict`
  on all ten, so the row it names has to exist and cannot be deleted while cited.
- Two organizations cannot share an identity fingerprint. Identity evidence is
  retained separately so stronger evidence upgrades the same organization in
  either arrival order and conflicts fail explicitly.
- A source document version cannot be rewritten and an observation cannot be
  updated or deleted. A changed page appends.
- A suppression entry cannot be un-revoked, re-timestamped, or revoked without a
  reason, and revoking one writes an audit event.
- A complaint cannot claim it suppressed something without naming the entry, and
  cannot be marked for review without saying why.
- Every table in the public schema has row level security enabled and forced,
  with no policies.
- A source policy row cannot be both `prohibited` and production-approved.
- A suppression entry cannot be edited or deleted, only revoked. A trigger
  enforces it.
- Education attributes cannot be attached to a non-education organization. A
  trigger enforces it.
- `audit_events` is append-only, and a database-serialized sequence participates
  in the canonical hash with the previous event and every material field.
- A completed export must record when suppression was checked, the count of
  withheld candidates and the checksum of what it wrote.
- A record API request must name an active purpose whose owner and human
  approval are stored in `export_purposes`.

Every migration that creates a table explicitly enables and forces row level
security on it. Default privileges revoke grants on future objects, but do not
enable row level security; the schema test checks every table for both the RLS
posture and the absence of policies.

## Testing posture

Tests run against TypeScript sources through vitest aliases, so `pnpm test`
needs no build. `tsconfig.tests.json` type-checks the test suite separately,
because the package builds exclude `*.test.ts` and a fixture that drifts from an
interface would otherwise fail only at run time.

Database tests run against a real in-process PostgreSQL 16
(`@electric-sql/pglite`), so constraints, triggers, recursive CTEs, `on conflict`
behaviour and `nulls not distinct` are exercised for real rather than mocked.
That is how the candidate generator's parameter-count defect was caught: nothing
but a database executing the statement would have found it.

PGlite has no `anon` role and no PostgREST, so it can prove that row level
security is enabled and forced on every table and cannot prove that an anonymous
PostgREST request is refused. That needs a Supabase integration test, tracked as
blocker RLS-1 in `BACKLOG.md`.
