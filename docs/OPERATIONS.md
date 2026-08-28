# Operations

## Local setup

Requirements: Node 22, pnpm 10, Docker (only for a local Postgres).

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL; leave the rest unset to start
pnpm verify               # format, lint, typecheck, test, build
```

`pnpm verify` needs no database and no network: database tests run against an
in-process PostgreSQL 16, and every crawl test reads saved fixtures.

## See it work

```bash
pnpm crawl:fixture
```

Crawls three saved directory pages, ingests them with provenance, crawls them
again to prove the recrawl adds nothing, records an opt-out, and writes
`out/fixture-export.csv` with that person absent. No network, no external
database, nothing left behind but the file.

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

## Inspecting a run

```bash
pnpm admin runs            # recent runs with pages, records, errors
pnpm admin failures        # errors grouped by kind, with an example each
pnpm admin coverage TX     # institution, record and email counts
pnpm admin sample TX       # lowest-confidence records, with source urls
pnpm admin titles TX       # titles the rule table does not recognize
```

`apps/api` serves `/health`, `/coverage?state=TX` and `/records?state=TX`. It is
read-only: it rejects every method other than GET, and has no route that sends,
exports around suppression, or mutates anything.

## Reading a crawl result

Each run records its stop reasons. They mean different things:

| Stop                    | Meaning                             | Action                                               |
| ----------------------- | ----------------------------------- | ---------------------------------------------------- |
| `completed`             | The frontier emptied                | None                                                 |
| `empty_success`         | Page parsed, nobody on it           | Check whether it is JS-rendered or the wrong adapter |
| `no_progress`           | Pages stopped yielding new people   | Usually correct; check the pager if unexpected       |
| `pagination_loop`       | A sequential pager revisited a page | Adapter or site issue; check the fixture             |
| `page_budget_exhausted` | Hit the run ceiling                 | Raise the budget deliberately, or narrow the target  |
| `blocked_by_robots`     | robots.txt disallowed the path      | Respect it. Do not work around it                    |
| `blocked_by_source`     | 401/403/429 or a challenge page     | Respect it. Record it and move on                    |

## Failure response

`unsupported_platform` is a coverage gap, not an error: a real platform
appearing repeatedly justifies an adapter. `blocked_by_source` and
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

See `CRAWLING_POLICY.md`. In short: verified sources, a real user agent with a
reachable policy page, a small approved sample first, read the failures, then
widen. Not before.
