# Working in this repository

Read this before changing anything. `docs/` has the detail; this file is the
short version of what must stay true.

## What this system is for

It collects publicly displayed U.S. public-sector organization and employee
directory data across six levels of government, normalizes it, and stores it
with provenance. It does not send outreach. If you find yourself adding a mail
transport, a send queue or an outreach API, stop: that belongs in a different
system.

## Rules that are not negotiable

1. **Never invent a value.** A field a source did not publish stays null. If a
   parse is uncertain, flag it (`lowConfidence`) rather than guessing. This
   applies to documentation and configuration too: an official source URL nobody
   has opened is `verified: false`.
2. **Stay inside the public professional data boundary.** Collect only what a
   public source published about someone's public role: name, title,
   department, organization, work location, public work phone, public work
   email. Never student information, government identification numbers, dates of
   birth, personal financial or medical information, home addresses, family
   information, personal email addresses, or anything behind authentication.
   `applyDataBoundary` in `@pan/core` enforces this on every ingested record.
3. **Never evade an access control.** No authentication, no CAPTCHA bypass, no
   retry-harder against a 403. A blocked source is recorded as blocked.
4. **Never collect from an unapproved source in production.** `prohibited` is
   absolute and no approval overrides it. `review_required` and `unknown` block
   until a person records an approval on the policy row. A vendor's assurance
   that data is compliant changes nothing.
5. **Never let an inferred address look published.** They live in different
   tables, and a CHECK constraint enforces it. Do not relax that constraint.
6. **Never bypass suppression.** It is applied in SQL and re-checked in memory
   immediately before an export is written. Both passes stay.
7. **Never commit a secret.** `.env.example` names variables and holds no
   values. Record what is connected, never the credential.
8. **No production crawl, deployment, commit, push or purchase** without
   explicit human approval.

## The neutrality rule

`packages/core`, `packages/shared-types`, `packages/taxonomy`,
`packages/database`, `packages/extraction`, the adapter packages, the
jurisdiction kit, the ingestion pipeline, the workers and the apps are
**neutral**. They may not name a school, a state, a directory platform or any
other single vertical, and they may not branch on one.

Vertical knowledge lives in exactly four places: a sector pack
(`packages/sectors/<sector>/`), a jurisdiction configuration
(`packages/jurisdiction-config/<key>/`), a directory adapter
(`packages/directory-adapters/<platform>/`), or a fixture.

`tests/neutral-core-guard.test.ts` enforces this by reading the source. It
strips comments first, so documentation examples are allowed and executable code
is not. One file is exempt by path,
`packages/taxonomy/src/reference/domains.ts`, because a table of `.us` DNS
labels is registry data rather than a branch on a vertical, and the test asserts
that file contains no imports, functions or branching.

## Conventions

- TypeScript strict, ESM, `NodeNext`. Relative imports end in `.js`.
- Comments explain _why_, not _what_. Do not narrate the code.
- No em dashes in prose or comments.
- Every material value carries provenance. If you add a table holding a value
  read from a page, add a `_has_provenance` CHECK constraint.
- A closed set that will never grow is a Postgres enum. A set that grows as
  sectors and jurisdictions are added is controlled reference data with a stable
  `code` primary key, seeded from the taxonomy. Adding an organization type or a
  role category must never require a migration.
- Every enum value exists in both `packages/shared-types/src/enums.ts` and a
  Postgres enum. `packages/database/src/schema.test.ts` fails if they drift.
- Every migration has a down script. Never edit an applied migration; the runner
  refuses to run when a checksum changes. Add a new one.
- Tests use saved fixtures. Nothing in the test suite may touch the network.

## Where things go

| Change                                           | Where                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| A new directory platform                         | `packages/directory-adapters/<platform>/` plus one `register` call |
| A new sector's org types, roles, titles, wording | `packages/sectors/<sector>/`                                       |
| A new jurisdiction at any level of government    | `packages/jurisdiction-config/<key>/` plus one `register` call     |
| Normalization, email logic, suppression, export  | `packages/core`                                                    |
| Crawl budgets, robots, guards, checkpointing     | `packages/core/src/crawl`                                          |
| Source policy and the data boundary              | `packages/core/src/policy`                                         |
| Schema                                           | `supabase/migrations`, with a down script                          |
| Anything vertical-specific                       | Never in a neutral package                                         |

`tests/extensibility.test.ts` asserts the last row. It builds ten public-sector
constructions inside the test file, from a school under a district to a federal
worker with a duty location and no state above them, and runs every one through
unmodified neutral core.

## Before you say it works

```bash
pnpm verify        # format, lint, typecheck (sources and tests), test, build
pnpm crawl:fixture # the pipeline end to end
```

Report what you actually ran and what it said. If something is untested or
unverified, say so plainly rather than implying otherwise.
