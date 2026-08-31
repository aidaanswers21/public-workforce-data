# Current state

Last updated: 2026-08-30. Phase: foundation generalized across six levels of
government, then corrected against an independent architecture review. No
production crawl run.

## What works

| Capability                                                                                                  | Status                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Monorepo, strict TypeScript, lint, typecheck (sources and tests), build, tests                              | Working                               |
| Schema: 40 tables, 12 reference tables, enums, constraints, triggers                                        | Working, tested against real Postgres |
| Migrations up and down, checksum guard                                                                      | Working                               |
| Controlled reference data seeded from the composed taxonomy                                                 | Working                               |
| Sector packs: education, state and local government, federal government                                     | Working                               |
| Neutral core guard, asserted by reading the source                                                          | Working                               |
| Effective-dated organization relationships, ancestry in SQL and in memory                                   | Working                               |
| Jurisdiction and duty location modelled separately                                                          | Working                               |
| Federal organizations with no state parent                                                                  | Working                               |
| Source policy gate, evaluated before robots and before the first fetch                                      | Working                               |
| Public professional data boundary, applied on every ingested record                                         | Working                               |
| Crawl engine: budgets, robots, retries, rate limiting, loop protection, checkpointing                       | Working                               |
| `generic-html` adapter: tables, cards, lists, definition lists, JSON-LD, microdata, mailto, data attributes | Working                               |
| `generic-json` adapter: cursor, offset, page pagination                                                     | Working                               |
| Obfuscated email decoding: entities, at/dot words, brackets, Cloudflare, data attributes                    | Working                               |
| Name, title, area, organization, unit, phone normalization, all vocabulary-driven                           | Working                               |
| Title normalization with recorded method, rule source, version and confidence                               | Working                               |
| Deduplication and person resolution                                                                         | Working                               |
| Email classification into six classes                                                                       | Working                               |
| Pattern inference with evidence, confidence separate from validation                                        | Working                               |
| Validation provider interface, no-op implementation                                                         | Working                               |
| Suppression: 11 scopes, enforced in SQL and re-checked at export                                            | Working                               |
| Organization-subtree suppression, both paths tested against each other                                      | Working                               |
| Complaints, immutable suppression, hash-chained audit trail                                                 | Working                               |
| CSV export with all 33 required fields                                                                      | Working                               |
| Texas education jurisdiction configuration                                                                  | Written, sources not yet verified     |
| Discovery worker                                                                                            | Working, not run against real sites   |
| Admin inspection CLI and read-only API                                                                      | Working                               |
| Fixture crawl end to end                                                                                    | Working: `pnpm crawl:fixture`         |

## What is deliberately not done

- **No production crawl has run.** Everything is fixture-driven.
- **No official source is verified.** Every `OfficialSource` in the Texas
  education configuration is `verified: false`, and the importer refuses to run
  against an unverified source. A person must open each URL and confirm the
  column mapping first. Outbound access to the relevant government hosts was
  blocked in the environment this was built in, so no URL here has been fetched.
- **No source policy has been reviewed or approved.** The gate therefore refuses
  every production collection today, which is the correct state before a review.
  It is also not yet loaded from the database at run time (C12), and the
  discovery worker does not consult it at all (C13).
- **Nine production blockers are open.** C12 to C18, C20, C21 and RLS-1 are
  documented in `BACKLOG.md` with their risk, resolution, required tests and
  what each one blocks. No live source may be fetched and no real outreach
  export may be used until the applicable ones are resolved.
- **Three environment variables groups are named and unwired.** The crawler
  identity, the object storage credentials and the n8n webhook are declared in
  `.env.example` and read by nothing. `.env.example` says so per variable.
- **Only the education sector has an extension table.** State, local and federal
  packs contribute types, roles, titles and vocabulary, and none of them needs
  attributes the neutral core does not already carry.
- **Only one jurisdiction is configured.** Texas education. State, county,
  municipal, special-district and federal jurisdictions are proven by
  constructions in `tests/extensibility.test.ts`, not by shipped configurations.
- **No browser rendering.** `requiresBrowser` is the seam; no adapter sets it.
- **No AI extraction.** The contract for it is in `BACKLOG.md`, unimplemented.
- **No raw response archiving.** `source_documents.storage_key` exists; the R2
  uploader does not.
- **No admin dashboard.** Inspection is a CLI and a read-only JSON API.
- **No n8n wiring.**

## Test coverage

788 tests across 26 files, all passing. Database tests run against real
PostgreSQL 16 in-process. No test touches the network.

The three tests that carry the generalization guarantees:

- `tests/extensibility.test.ts`, 18 tests: ten public-sector constructions built
  inside the test file and run through unmodified neutral core.
- `tests/neutral-core-guard.test.ts`, 10 tests: reads every neutral source file
  and fails on education terms, platform vendors, state names and forbidden
  imports.
- `tests/title-taxonomy.test.ts`, 68 tests: scoped title resolution across all
  three sector packs, including nine titles one vertical owns and another uses
  differently.
- `services/validation-worker/src/candidates.test.ts`, 9 tests: the email
  candidate generator against real PostgreSQL, which is the only thing that
  would have caught its parameter-count defect.

## Immediate next steps

1. Verify the four Texas education official sources by hand and set
   `verified: true`.
2. Review and approve source policies for those domains.
3. Run the importer against the verified files; check the county count against 254.
4. Run discovery over a small approved sample of organization sites.
5. Read the failure breakdown; decide whether any real platform justifies an
   adapter, or whether the sector vocabulary is simply missing wording.
6. Only then consider widening, to another sector or another jurisdiction.
