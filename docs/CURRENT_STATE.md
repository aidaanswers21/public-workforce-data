# Current state

Last updated: 2026-08-28. Phase: foundation complete, no production crawl run.

## What works

| Capability                                                                                 | Status                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Monorepo, strict TypeScript, lint, typecheck, build, tests                                 | Working                               |
| Schema: 23 tables, enums, constraints, triggers                                            | Working, tested against real Postgres |
| Migrations up and down, checksum guard                                                     | Working                               |
| Crawl engine: budgets, robots, retries, rate limiting, loop protection, checkpointing      | Working                               |
| `generic-html` adapter: tables, cards, lists, definition lists, JSON-LD, microdata, mailto | Working                               |
| `generic-json` adapter: cursor, offset, page pagination                                    | Working                               |
| Obfuscated email decoding: entities, at/dot words, brackets, Cloudflare, data attributes   | Working                               |
| Name, title, county, district, school, department, phone normalization                     | Working                               |
| Deduplication and person resolution                                                        | Working                               |
| Email classification into six classes                                                      | Working                               |
| Pattern inference with evidence, confidence separate from validation                       | Working                               |
| Validation provider interface, no-op implementation                                        | Working                               |
| Suppression: 7 scopes, enforced in SQL and re-checked at export                            | Working                               |
| Complaints, immutable suppression, hash-chained audit trail                                | Working                               |
| CSV export with all 25 required fields                                                     | Working                               |
| Texas state configuration                                                                  | Written, sources not yet verified     |
| Discovery worker                                                                           | Working, not run against real sites   |
| Admin inspection CLI and read-only API                                                     | Working                               |
| Fixture crawl end to end                                                                   | Working: `pnpm crawl:fixture`         |

## What is deliberately not done

- **No production crawl has run.** Everything is fixture-driven.
- **No official Texas source is verified.** Every `OfficialSource` is
  `verified: false`, and the importer refuses to run against an unverified
  source. A person must open each URL and confirm the column mapping first.
  Outbound access to `tea.texas.gov` and `nces.ed.gov` was blocked in the
  environment this was built in, so no URL here has been fetched.
- **No browser rendering.** `requiresBrowser` is the seam; no adapter sets it.
- **No AI extraction.** The contract for it is in `BACKLOG.md`, unimplemented.
- **No raw response archiving.** `source_pages.storage_key` exists; the R2
  uploader does not.
- **No admin dashboard.** Inspection is a CLI and a read-only JSON API.
- **No n8n wiring.**

## Test coverage

505 tests across 20 files, all passing. Database tests run against real
PostgreSQL 16 in-process. No test touches the network.

## Immediate next steps

1. Verify the four Texas official sources by hand and set `verified: true`.
2. Run the importer against the TEA district and campus files; check the county
   count against 254.
3. Run discovery over a small approved sample of district sites.
4. Read the failure breakdown; decide whether any real platform justifies an
   adapter.
5. Only then consider widening.
