# Working in this repository

Read this before changing anything. `docs/` has the detail; this file is the
short version of what must stay true.

## What this system is for

It collects publicly displayed K-12 school and employee directory data,
normalizes it, and stores it with provenance. It does not send outreach. If you
find yourself adding a mail transport, a send queue or an outreach API, stop:
that belongs in a different system.

## Rules that are not negotiable

1. **Never invent a value.** A field a source did not publish stays null. If a
   parse is uncertain, flag it (`lowConfidence`) rather than guessing. This
   applies to documentation and configuration too: an official source URL nobody
   has opened is `verified: false`.
2. **Never collect student information.** Not names, schedules, photographs or
   rosters.
3. **Never evade an access control.** No authentication, no CAPTCHA bypass, no
   retry-harder against a 403. A blocked source is recorded as blocked.
4. **Never let an inferred address look published.** They live in different
   tables, and a CHECK constraint enforces it. Do not relax that constraint.
5. **Never bypass suppression.** It is applied in SQL and re-checked in memory
   immediately before an export is written. Both passes stay.
6. **Never commit a secret.** `.env.example` names variables and holds no
   values. Record what is connected, never the credential.
7. **No production crawl, deployment, commit, push or purchase** without
   explicit human approval.

## Conventions

- TypeScript strict, ESM, `NodeNext`. Relative imports end in `.js`.
- Comments explain _why_, not _what_. Do not narrate the code.
- No em dashes in prose or comments.
- Every material value carries provenance. If you add a table holding a value
  read from a page, add a `_has_provenance` CHECK constraint.
- Every enum value exists in both `packages/shared-types/src/enums.ts` and a
  Postgres enum. `packages/database/src/schema.test.ts` fails if they drift.
- Every migration has a down script. Never edit an applied migration; the runner
  refuses to run when a checksum changes. Add a new one.
- Tests use saved fixtures. Nothing in the test suite may touch the network.

## Where things go

| Change                                          | Where                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| A new directory platform                        | `packages/directory-adapters/<platform>/` plus one `register` call |
| A new state                                     | `packages/state-config/<state>/` plus one `register` call          |
| Normalization, email logic, suppression, export | `packages/core`                                                    |
| Crawl budgets, robots, guards, checkpointing    | `packages/core/src/crawl`                                          |
| Schema                                          | `supabase/migrations`, with a down script                          |
| Anything platform- or state-specific            | Never in `packages/core`                                           |

`tests/extensibility.test.ts` asserts the last row: it builds an adapter and a
state config inside the test file and runs them through unmodified core code,
and it greps the crawl engine for state and platform names.

## Before you say it works

```bash
pnpm verify        # format, lint, typecheck, test, build
pnpm crawl:fixture # the pipeline end to end
```

Report what you actually ran and what it said. If something is untested or
unverified, say so plainly rather than implying otherwise.
