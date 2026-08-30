# pension-appointment-network

An internal data platform for collecting publicly available U.S. public-sector
organization and employee directory information.

It imports an authoritative list of public bodies for a jurisdiction, finds each
organization's official staff directory, extracts the people those pages
publish, normalizes and deduplicates them, keeps published addresses strictly
separate from inferred candidates, and enforces source policy and suppression
inside the data layer before anything can be exported.

**This repository collects and manages data. It does not send outreach.** There
is no mail transport, no send API and no outreach queue anywhere in it.

## What it covers

Six levels of United States public employment, through one neutral core:

| Level                             | Examples                                                  |
| --------------------------------- | --------------------------------------------------------- |
| K-12 education                    | School districts, schools, charter organizations, ESAs    |
| State government                  | Departments, boards, commissions, state agencies          |
| County government                 | County offices, elected offices, county departments       |
| Municipal and local government    | Cities, towns, townships, villages                        |
| Special districts and authorities | Water, transit, port, utility and housing authorities     |
| Federal government                | Departments, independent agencies, regional offices, labs |

Education is one sector extension among several, not the shape of the platform.
The core knows about organizations, relationships, jurisdictions and duty
locations. It does not know what a school is. See
[EDUCATION_IN_THE_PLATFORM](docs/EDUCATION_IN_THE_PLATFORM.md).

Starting jurisdiction: **Texas K-12 education**. Adding a jurisdiction, a sector
or a directory platform is configuration, not a change to the crawler.

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
packages/    shared types, taxonomy, core domain logic, extraction, database,
             directory adapters, sector packs, jurisdiction configuration,
             observability
supabase/    migrations, each with a down script
tests/       fixtures and cross-package tests
docs/        the documentation set below
```

## Documentation

| Document                                                               | What it covers                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [ARCHITECTURE](docs/ARCHITECTURE.md)                                   | Shape, the four extensibility seams, why the crawl engine is ours        |
| [DATA_MODEL](docs/DATA_MODEL.md)                                       | Tables, reference data, provenance, identity, email classes, suppression |
| [ORGANIZATION_HIERARCHY](docs/ORGANIZATION_HIERARCHY.md)               | Effective-dated relationships, ancestry, subtree suppression             |
| [JURISDICTION_VS_DUTY_LOCATION](docs/JURISDICTION_VS_DUTY_LOCATION.md) | Why who governs and where someone works are separate facts               |
| [SECTOR_EXTENSIONS](docs/SECTOR_EXTENSIONS.md)                         | Adding a sector without touching the core                                |
| [EDUCATION_IN_THE_PLATFORM](docs/EDUCATION_IN_THE_PLATFORM.md)         | Where education knowledge lives and why it is not in the core            |
| [SOURCE_POLICY_REVIEW](docs/SOURCE_POLICY_REVIEW.md)                   | Reviewing a source, recording approval, what a vendor cannot override    |
| [ONBOARDING_STATE_LOCAL](docs/ONBOARDING_STATE_LOCAL.md)               | Adding a state, county, municipal or special-district jurisdiction       |
| [ONBOARDING_FEDERAL](docs/ONBOARDING_FEDERAL.md)                       | Adding a federal agency, which has no state above it                     |
| [CRAWLING_POLICY](docs/CRAWLING_POLICY.md)                             | Scope, source policy, robots, limits, guards, what we never do           |
| [DIRECTORY_ADAPTERS](docs/DIRECTORY_ADAPTERS.md)                       | The adapter contract and how to add one                                  |
| [DATA_QUALITY](docs/DATA_QUALITY.md)                                   | Confidence, normalization provenance, known limitations, checks          |
| [SECURITY](docs/SECURITY.md)                                           | Secrets, logging, the public professional data boundary, opt-outs        |
| [OPERATIONS](docs/OPERATIONS.md)                                       | Setup, migrations, inspecting runs, reading results                      |
| [CURRENT_STATE](docs/CURRENT_STATE.md)                                 | What works, what is deliberately not done                                |
| [BACKLOG](docs/BACKLOG.md)                                             | What is next, in order                                                   |

## Status

Foundation complete and generalized across six levels of government. **No
production crawl has been run**, and no official source has been verified yet:
every source in the Texas education configuration is marked `verified: false`,
the importer refuses to run against an unverified source, and the crawler
refuses production collection from any source a person has not approved. See
[CURRENT_STATE](docs/CURRENT_STATE.md).

## Stack

Node 22, TypeScript strict, pnpm workspaces, Turborepo, PostgreSQL (Supabase),
cheerio, Vitest, structured JSON logging via pino. Database tests run against a
real in-process PostgreSQL 16, so constraints and triggers are exercised for
real rather than mocked.
