# Current state

Last updated: 2026-09-08. Phase: foundation generalized across six levels of
government, then corrected against an independent architecture review. No
production crawl run.

## What works

| Capability                                                                                                        | Status                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Monorepo, strict TypeScript, lint, typecheck (sources and tests), build, tests                                    | Working                                                        |
| Schema: 53 tables in the local harness, 14 reference tables, enums, constraints, triggers                         | Working, tested against real Postgres                          |
| Migrations up and down, checksum guard                                                                            | Working                                                        |
| Controlled reference data seeded from the composed taxonomy                                                       | Working                                                        |
| Sector packs: education, state and local government, federal government                                           | Working                                                        |
| Neutral core guard, asserted by reading the source                                                                | Working                                                        |
| Effective-dated organization relationships, ancestry in SQL and in memory                                         | Working                                                        |
| Jurisdiction and duty location modelled separately                                                                | Working                                                        |
| Federal organizations with no state parent                                                                        | Working                                                        |
| Source policy gate plus operator review and separate approval workflow                                            | Working                                                        |
| Public professional data boundary, applied on every ingested record                                               | Working                                                        |
| Crawl engine: budgets, robots, retries, rate limiting, loop protection, boundary-safe checkpointing               | Working                                                        |
| `generic-html` adapter: tables, cards, lists, definition lists, JSON-LD, microdata, mailto, data attributes       | Working                                                        |
| `generic-json` adapter: cursor, offset, page pagination                                                           | Working                                                        |
| Obfuscated email decoding: entities, at/dot words, brackets, Cloudflare, data attributes                          | Working                                                        |
| Name, title, area, organization, unit, phone normalization, all vocabulary-driven                                 | Working                                                        |
| Title normalization with recorded method, rule source, version and confidence                                     | Working                                                        |
| Deduplication and person resolution                                                                               | Working                                                        |
| Email classification into six classes                                                                             | Working                                                        |
| Pattern inference with evidence, confidence separate from validation                                              | Working                                                        |
| Validation provider interface, no-op implementation                                                               | Working                                                        |
| Suppression: 11 scopes, enforced in SQL and re-checked at export                                                  | Working                                                        |
| Organization-subtree suppression, both paths tested against each other                                            | Working                                                        |
| Idempotent complaint intake, immutable suppression, serialized hash-chained audit trail                           | Working                                                        |
| CSV export with 33 fields and independent channel suppression accounting                                          | Working                                                        |
| Texas education jurisdiction configuration                                                                        | Written, sources not yet verified                              |
| Discovery worker                                                                                                  | Working, not run against real sites                            |
| National bulk-file organizer, exact-ID canonicalizer, jurisdiction/relationship materializer and website overlays | Working locally; first hosted import predates the materializer |
| Missing-website queue and evidence-backed candidate review                                                        | Working locally, no live search run                            |
| Private local/hosted operator console with separate staged and hosted organization-spine coverage                 | Working and hosted                                             |
| Sector-configured organization explorer with profiles, official aggregates, provenance and bulk selection         | Working                                                        |
| Collection projects, active scope controls, approved-batch completion, durable leased scheduler jobs              | Working, no live batch run                                     |
| Long-lived approved-job daemon and Render web/worker Blueprint                                                    | Working, manual deploys configured                             |
| Cross-worker one-active-job-per-domain guard, page and error batch stops                                          | Working                                                        |
| Persistent embedded fixture database                                                                              | Working: `pnpm local:setup`                                    |
| Fixture crawl end to end                                                                                          | Working: `pnpm crawl:fixture`                                  |

## What is deliberately not done

- **No production crawl has run.** Everything is fixture-driven.
- **The first organization import is complete, but no production directory
  crawl has run.** The hosted database contains 231,016 provenance-bearing
  source records and 52,557 exact-ID canonical organizations. The remaining
  source records stay in explicit classification, overlay or reconciliation
  holds rather than receiving guessed values. Migration 0019 and the new
  AskTED materialization path have not been applied to that hosted database;
  doing so requires a new approval.
- **Bulk-import approval does not approve live collection.** The scheduler
  loads policy rows from the database and moves unreviewed targets to
  `policy_hold`; discovery independently checks the same policy registry and
  robots before fetching. Existing source-policy approvals are narrowly scoped
  to the completed organization import. A person must separately review and
  approve any live directory batch.
- **Ten production blockers are open.** C12 to C18, C20, C21 and RLS-1 are
  documented in `BACKLOG.md` with their risk, resolution, required tests and
  what each one blocks. No live source may be fetched and no real outreach
  export may be used until the applicable ones are resolved.
- **Reserved environment variables remain visibly unwired.** Crawl-limit
  overrides, object storage, validation-provider and n8n settings are declared
  in `.env.example` and read by nothing. Crawler identity is now required by the
  finite approved-batch worker. `.env.example` says so per variable.
- **Only the education sector has an extension table.** State, local and federal
  packs contribute types, roles, titles and vocabulary, and none of them needs
  attributes the neutral core does not already carry.
- **National Census collection scopes are configured and their exact-ID rows
  are loaded.** Eight configurations cover the source-supported county,
  municipal, township and education combinations in the organized release.
  The project builder can narrow a national configuration by state. Federal and
  state general-government rows remain held until their authoritative hierarchy
  or source is reconciled; the console does not present those as ready.
- **No browser rendering.** `requiresBrowser` is the seam; no adapter sets it.
- **No AI extraction.** The contract for it is in `BACKLOG.md`, unimplemented.
- **No raw response archiving.** `source_documents.storage_key` exists; the R2
  uploader does not.
- **No public or multi-user admin application.** The browser console is a
  private single-operator service with its own hashed-password login. It can
  define collection projects, record source-policy decisions, and approve
  finite batches. It does not authenticate `apps/api`, grant approval without a
  human, or run the continuously operating worker inside the web process.
- **No n8n wiring.**

## Test coverage

The current verified count is reported after each full `pnpm verify` run.
Database tests run against real PostgreSQL 16 in-process. No test touches the
network.

The tests that carry the generalization and persistence guarantees:

- `tests/extensibility.test.ts`, 21 tests: ten public-sector constructions built
  inside the test file and run through unmodified neutral core.
- `tests/neutral-core-guard.test.ts`, 13 tests: reads every neutral source file
  and fails on education terms, platform vendors, state names and forbidden
  imports. A regression test also proves the guard fails when a prohibited term
  is placed in neutral executable code.
- `tests/title-taxonomy.test.ts`, 68 tests: scoped title resolution across all
  three sector packs, including nine titles one vertical owns and another uses
  differently.
- `services/validation-worker/src/candidates.test.ts`, 9 tests: the email
  candidate generator against real PostgreSQL, which is the only thing that
  would have caught its parameter-count defect.
- `packages/database/src/pglite.test.ts`, 1 test: applies the full migration set
  to a file-backed embedded database, closes it, reopens it, and proves the data
  persisted.

## Immediate next steps

1. Review the organized national-spine summary and unresolved classifications.
2. Confirm the exact official artifacts intended for a production import.
3. Use the organization explorer to inspect official aggregate values and add
   source records to draft collection projects.
4. Resolve authoritative government-level classification for held source rows
   before treating them as crawl-ready organizations.
5. Review and approve policies for any source that will receive live requests.
6. Resolve missing organization websites in bulk-first order.
7. Run directory discovery over a small separately approved sample of organization sites.
8. Read the failure breakdown; decide whether any real platform justifies an
   adapter, or whether the sector vocabulary is simply missing wording.
9. Only then consider widening employee collection.
