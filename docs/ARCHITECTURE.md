# Architecture

## What this is

An internal data platform that collects publicly displayed U.S. K-12 school and
employee directory information, normalizes it, and stores it with complete
source provenance. It collects and manages data. It does not send outreach of
any kind, and there is no code path in this repository that sends an email.

## Shape

```
apps/admin           inspection CLI over runs, coverage, failures, samples
apps/api             read-only HTTP API over coverage and records

services/
  crawler-worker     fetchers, the ingestion pipeline, the fixture crawl CLI
  discovery-worker   finds a district or school's directory and records a target
  validation-worker  candidate generation and validation-provider driving

packages/
  shared-types       vocabularies, entities, and the adapter contract
  core               normalization, email logic, dedup, suppression, crawl engine, export
  extraction         cheerio-based HTML and structured-data helpers
  database           migrations, repositories, the Postgres client
  directory-adapters kit (contract, registry, contract tests) plus per-platform adapters
  state-config       kit (types, registry, importer) plus per-state configuration
  observability      structured JSON logging and run metrics

supabase/migrations  the schema, with a down script for every migration
tests/fixtures       saved pages and API responses; no test touches the network
```

## The two seams that make this extensible

**Directory adapters.** `DirectoryAdapter` in `@pan/shared-types` is the whole
contract: detect, discover, extract a listing, extract a profile, discover
pagination. Adding a platform is a new class plus one `register` call in
`services/crawler-worker/src/registries.ts`. The crawl engine, the schema and
the ingestion pipeline are untouched. See `DIRECTORY_ADAPTERS.md`.

**State configuration.** `StateConfig` in `@pan/state-kit` holds official
sources, column mappings, identifier mappings, county aliases, seeds and crawl
tuning. Adding a state is a new config object plus one `register` call. See
`STATE_ONBOARDING.md`.

`tests/extensibility.test.ts` asserts both properties directly rather than
leaving them as claims.

## Why the crawl engine is ours

`CrawlEngine` in `@pan/core` owns everything that must not vary by platform:
budgets, per-domain rate limiting, robots, retries, cross-domain refusal, URL
exclusion, loop protection, empty-success detection and checkpointing. Adapters
answer only "what is on this page" and "where is the next one".

That split is the reason the engine is not built on a crawling framework. The
framework features we would use, a request queue and a scheduler, are the ones
we had to own anyway to get per-target resumability tied to our own database.
The features we would not use, session pools and proxy rotation, exist to avoid
being detected, and this platform does the opposite: a source that blocks us is
recorded and left alone.

The transport sits behind the `Fetcher` port, so this decision is reversible in
one file. `HttpFetcher` uses Node 22's built-in fetch. `FixtureFetcher` serves
saved files and is what every test and `pnpm crawl:fixture` run against, which
is why no test can accidentally reach a real district site.

Browser rendering is not implemented. `DirectoryAdapter.requiresBrowser` is the
seam it would arrive behind, and it is in `BACKLOG.md`.

## Data flow

```
official state file  ->  importer         ->  districts, schools, counties
district website     ->  discovery-worker ->  crawl_targets
crawl target         ->  CrawlEngine      ->  harvested records + pages + errors
harvested records    ->  IngestionPipeline->  source_observations, people,
                                              employment_assignments, email_addresses
published addresses  ->  CandidateGenerator-> email_candidates (separate pass)
candidates           ->  ValidationRunner ->  email_validation_results
records              ->  ExportRepository ->  CSV, suppression enforced twice
```

## Invariants the code cannot violate

These are enforced by the schema, not by convention. See `DATA_MODEL.md`.

- An inferred address cannot be stored in `email_addresses`. A CHECK constraint
  restricts that table to classes a source actually displayed.
- A district, school, person, assignment or address cannot exist without
  provenance. A CHECK constraint requires a source page or inference evidence.
- A suppression entry cannot be edited or deleted, only revoked. A trigger
  enforces it.
- `audit_events` is append-only, and each row hashes the previous one.
- A completed export must record when suppression was checked and the checksum
  of what it wrote.

## Testing posture

Tests run against TypeScript sources through vitest aliases, so `pnpm test`
needs no build. Database tests run against a real in-process PostgreSQL 16
(`@electric-sql/pglite`), so constraints, triggers, `on conflict` behaviour and
`nulls not distinct` are exercised for real rather than mocked.
