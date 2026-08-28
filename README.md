# pension-appointment-network

An internal data platform for collecting publicly available U.S. K-12 school and
employee directory information.

It imports the authoritative list of districts and schools for a state, finds
each institution's official staff directory, extracts the people those pages
publish, normalizes and deduplicates them, keeps published addresses strictly
separate from inferred candidates, and enforces suppression and opt-outs inside
the data layer before anything can be exported.

**This repository collects and manages data. It does not send outreach.** There
is no mail transport, no send API and no outreach queue anywhere in it.

Starting state: **Texas**. Adding another state is a configuration package, not
a code change.

## Quick start

```bash
pnpm install
pnpm verify        # format, lint, typecheck, test, build. No database, no network.
pnpm crawl:fixture # the whole pipeline against saved fixtures
```

`pnpm crawl:fixture` crawls three saved directory pages, stores the people with
full provenance, crawls them again to show the recrawl adds nothing, records an
opt-out, and writes `out/fixture-export.csv` with that person absent. It uses an
in-process PostgreSQL and touches no network.

## Layout

```
apps/        admin inspection CLI, read-only API
services/    crawler, discovery and validation workers
packages/    shared types, core domain logic, extraction, database,
             directory adapters, state configuration, observability
supabase/    migrations, each with a down script
tests/       fixtures and cross-package tests
docs/        the documentation set below
```

## Documentation

| Document                                         | What it covers                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| [ARCHITECTURE](docs/ARCHITECTURE.md)             | Shape, the two extensibility seams, why the crawl engine is ours |
| [DATA_MODEL](docs/DATA_MODEL.md)                 | Tables, provenance, identity, the six email classes, suppression |
| [CRAWLING_POLICY](docs/CRAWLING_POLICY.md)       | Scope, robots, limits, guards, exclusions, what we never do      |
| [STATE_ONBOARDING](docs/STATE_ONBOARDING.md)     | The process and the definition of done for a new state           |
| [DIRECTORY_ADAPTERS](docs/DIRECTORY_ADAPTERS.md) | The adapter contract and how to add one                          |
| [DATA_QUALITY](docs/DATA_QUALITY.md)             | Confidence, known limitations, the checks that run               |
| [SECURITY](docs/SECURITY.md)                     | Secrets, logging, data minimization, opt-outs                    |
| [OPERATIONS](docs/OPERATIONS.md)                 | Setup, migrations, inspecting runs, reading results              |
| [CURRENT_STATE](docs/CURRENT_STATE.md)           | What works, what is deliberately not done                        |
| [BACKLOG](docs/BACKLOG.md)                       | What is next, in order                                           |

## Status

Foundation complete. **No production crawl has been run**, and no official
Texas source has been verified yet: every source in the Texas config is marked
`verified: false`, and the importer refuses to run against an unverified source
until a person has opened the URL and confirmed the column mapping. See
[CURRENT_STATE](docs/CURRENT_STATE.md).

## Stack

Node 22, TypeScript strict, pnpm workspaces, Turborepo, PostgreSQL (Supabase),
cheerio, Vitest, structured JSON logging via pino. Database tests run against a
real in-process PostgreSQL 16, so constraints and triggers are exercised for
real rather than mocked.
