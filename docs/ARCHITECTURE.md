# Architecture

## What this is

An internal data platform that collects publicly displayed U.S. public-sector
organization and employee directory information across six levels of government,
normalizes it, and stores it with complete source provenance. It collects and
manages data. It does not send outreach of any kind, and there is no code path in
this repository that sends an email.

## Shape

```
apps/admin           inspection CLI over runs, coverage, failures, samples, policies
apps/api             read-only HTTP API over coverage and records

services/
  crawler-worker     fetchers, the ingestion pipeline, the fixture crawl CLI
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

One file is exempt by path,
`packages/taxonomy/src/reference/domains.ts`, which lists the DNS labels
published under `.us` so the crawler can tell `co.harris.tx.us` from
`ci.austin.tx.us`. The test asserts that file holds no imports, no functions and
no branching, so the exemption stays a table.

## The four seams that make this extensible

**Directory adapters.** `DirectoryAdapter` in `@pan/shared-types` is the whole
contract: detect, discover, extract a listing, extract a profile, discover
pagination. Adding a platform is a new class plus one `register` call in
`services/crawler-worker/src/registries.ts`. See `DIRECTORY_ADAPTERS.md`.

**Sector packs.** `SectorPack` in `@pan/taxonomy` contributes organization
types, identifier systems, job families, role categories, title rules, specialty
patterns and directory vocabulary. `Taxonomy` composes the base with every
registered pack and calls `assertCoherent()`, which throws if a pack names a
government level, sector, job family or role category that does not exist. No
migration is needed, because these are reference rows and not enum values. See
`SECTOR_EXTENSIONS.md`.

**Jurisdiction configuration.** `JurisdictionConfig` in `@pan/jurisdiction-kit`
holds a government level, the sectors in play, official sources, column
mappings, identifier mappings, area aliases, seeds and crawl tuning. A
jurisdiction is a state, a county, a city, a special district or the federal
government, so `state-config` is deliberately not the abstraction: the federal
government is not a state. `validateJurisdictionConfig` reports an error if a
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

`CrawlEngine` in `@pan/core` owns everything that must not vary by platform or
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
organization website ->  discovery-worker  ->  crawl_targets
source policy        ->  SourcePolicyGate  ->  allowed, or refused and recorded
crawl target         ->  CrawlEngine       ->  harvested records + documents + errors
harvested records    ->  data boundary     ->  prohibited fields dropped and counted
surviving records    ->  IngestionPipeline ->  source_observations (evidence-classed),
                                               people, employment_assignments,
                                               contact_points, email_addresses
published addresses  ->  CandidateGenerator->  email_candidates (separate pass)
candidates           ->  ValidationRunner  ->  email_validation_results
records              ->  ExportRepository  ->  CSV, suppression enforced twice
```

## Invariants the code cannot violate

These are enforced by the schema, not by convention. See `DATA_MODEL.md`.

- An inferred address cannot be stored in `email_addresses`. A CHECK constraint
  restricts that table to classes a source actually displayed.
- An organization, person, assignment, contact point or address cannot exist
  without provenance. A CHECK constraint on eight tables requires a source
  document or inference evidence.
- A source policy row cannot be both `prohibited` and production-approved.
- A suppression entry cannot be edited or deleted, only revoked. A trigger
  enforces it.
- Education attributes cannot be attached to a non-education organization. A
  trigger enforces it.
- `audit_events` is append-only, and each row hashes the previous one.
- A completed export must record when suppression was checked and the checksum
  of what it wrote.

## Testing posture

Tests run against TypeScript sources through vitest aliases, so `pnpm test`
needs no build. `tsconfig.tests.json` type-checks the test suite separately,
because the package builds exclude `*.test.ts` and a fixture that drifts from an
interface would otherwise fail only at run time.

Database tests run against a real in-process PostgreSQL 16
(`@electric-sql/pglite`), so constraints, triggers, recursive CTEs, `on conflict`
behaviour and `nulls not distinct` are exercised for real rather than mocked.
