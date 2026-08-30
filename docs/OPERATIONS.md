# Operations

## Local setup

Requirements: Node 22, pnpm 10, Docker (only for a local Postgres).

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL; leave the rest unset to start
pnpm verify               # format, lint, typecheck, test, build
```

`pnpm verify` needs no database and no network: database tests run against an
in-process PostgreSQL 16, and every crawl test reads saved fixtures. The
typecheck step covers both the packages and the test suite, because the package
builds exclude `*.test.ts`.

## See it work

```bash
pnpm crawl:fixture
```

Crawls three saved directory pages, ingests them with provenance, crawls them
again to prove the recrawl adds nothing, records an opt-out, and writes
`out/fixture-export.csv` with that person absent. It also demonstrates
organization-subtree suppression: suppressing the parent organization drops the
export to zero rows. No network, no external database, nothing left behind but
the file.

## Database

```bash
docker compose up -d postgres
pnpm db:migrate                      # apply pending migrations
pnpm db:migrate -- --check           # validate the files, no database needed
pnpm db:migrate -- --rollback 0005   # revert down to and including 0005
```

Every migration has a down script. The runner records a checksum per migration
and refuses to run when an applied one has been edited: the fix for a shipped
migration is a new migration, never a rewritten one.

Reference data is seeded from the composed taxonomy rather than from SQL, so
adding a sector's organization types or role categories needs no migration.
`seedReferenceData(client, taxonomy)` writes whatever the registered packs
contributed.

## Inspecting a run

```bash
pnpm admin runs           # recent runs with pages, records, errors
pnpm admin failures       # errors grouped by kind, with an example each
pnpm admin coverage       # organization, record and email counts
pnpm admin organizations  # organizations by level and type
pnpm admin policies       # sources awaiting review or production approval
pnpm admin sample         # lowest-confidence records, with source urls
pnpm admin titles         # titles the composed rule table does not recognize
```

`coverage` takes an optional government level and sector, so
`pnpm admin coverage education` and `pnpm admin coverage federal` are separate
questions with separate denominators.

`apps/api` serves `/health`, `/coverage` and `/records`. It is read-only: it
rejects every method other than GET, and has no route that sends, exports around
suppression, or mutates anything.

## Reading a crawl result

Each run records its stop reasons. They mean different things:

| Stop                       | Meaning                                  | Action                                                                    |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `completed`                | The frontier emptied                     | None                                                                      |
| `blocked_by_source_policy` | No approved policy for the source        | Review and approve the source, or leave it alone                          |
| `empty_success`            | Page parsed, nobody on it                | Check whether it is JS-rendered, the wrong adapter, or missing vocabulary |
| `no_progress`              | Pages stopped yielding new people        | Usually correct; check the pager if unexpected                            |
| `pagination_loop`          | A sequential pager revisited a page      | Adapter or site issue; check the fixture                                  |
| `duplicate_content`        | A body hashed the same as an earlier one | Usually a pager returning the same page                                   |
| `page_budget_exhausted`    | Hit the run ceiling                      | Raise the budget deliberately, or narrow the target                       |
| `blocked_by_robots`        | robots.txt disallowed the path           | Respect it. Do not work around it                                         |
| `blocked_by_source`        | 401/403/429 or a challenge page          | Respect it. Record it and move on                                         |

## Failure response

`policy_hold` is not an error: it is the gate working, and the response is a
source review, not a retry. `unsupported_platform` is a coverage gap, and a real
platform appearing repeatedly justifies an adapter. `blocked_by_source` and
`robots_disallowed` are final. `network` and `timeout` are already retried twice
with backoff; if they persist, the site is down or slow, not blocking us.

## Orchestration

Crawling runs in the Node worker, never in an orchestrator. n8n, if used, starts
jobs and receives completion events over webhooks; it does not fetch pages. Set
`N8N_WEBHOOK_URL` to receive run-completion notifications. Nothing is wired to
n8n today.

## Cost

There is no billable dependency in the shipped configuration. The only
cost-bearing component is a validation provider, and the default is a no-op that
cannot spend anything. `ValidationProviderInfo.billable` marks a provider that
bills per address, and `email_validation_results` records the provider and
request id per check so spend is attributable.

## Before a production crawl

See `CRAWLING_POLICY.md` and `SOURCE_POLICY_REVIEW.md`. In short: verified
sources, approved source policies, a real user agent with a reachable policy
page, a small approved sample first, read the failures, then widen. Not before.
