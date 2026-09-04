# Operations

## Local setup

Requirements: Node 22 and pnpm 10. Docker is optional and needed only for a
separate local Postgres server.

```bash
pnpm install
cp .env.example .env      # fill in DATABASE_URL; leave the rest unset to start
pnpm verify               # format, lint, typecheck, test, build
```

`pnpm verify` needs no database and no network: database tests run against an
in-process PostgreSQL 16, and every crawl test reads saved fixtures. The
typecheck step covers both the packages and the test suite, because the package
builds exclude `*.test.ts`.

### Local operator console

The browser console uses an embedded PostgreSQL database inside this workspace,
so Docker is not required. Its fixture setup never contacts a live source.

```bash
pnpm local:setup  # migrate and seed storage/local-admin-db from saved fixtures
pnpm local:start  # print the private local URL and keep the console running
```

Open the printed URL and use `LOCAL_ADMIN_EMAIL` and `LOCAL_ADMIN_PASSWORD` from
the gitignored `.env.local` file. The server binds to `127.0.0.1`, signs an
HTTP-only same-site session cookie, and displays coverage, evidence samples,
organization counts, and recent fixture runs. Search and sign-out are available
in the browser.

When `.env.local` also contains `DATABASE_URL`, the same private console reads
the managed PostgreSQL database instead of the embedded fixture database. It
does not run the local migration harness against that remote database and still
binds only to `127.0.0.1`, so opening the production database does not publish
the console to the internet.

**Collection projects** lets an operator choose a registered jurisdiction and
sector from dropdowns backed by the controlled taxonomy, choose organization
types with an accessible click-or-drag shelf, materialize organization
membership, generate discovery targets from published website URLs, and release
one finite batch. Exact organization identifiers remain optional advanced text
filters because a national identifier set is not a useful menu. Project creation
and target generation do not access the network. Batch approval records the
signed-in operator, the exact target limit, and a required note. A target is an
organization website, not one person, so a finite batch may produce thousands of
observed public professional records. Approval does not carry to a later batch.
The local console does not start a production worker, and no live batch has run.

Only registered jurisdiction configurations are executable. The menus therefore
grow from the jurisdiction registry and taxonomy instead of presenting an
unbacked national list as ready. Adding the national organization index and each
verified jurisdiction/source configuration will populate the same controls
without adding branches to the console or crawler.

The production entry point refuses to start without one approved batch ID, a
database URL and the crawler identity. A supervised run may use a local job
ceiling:

```bash
pnpm collection:work -- --batch-id <approved-batch-uuid> --max-jobs 10
```

To keep working until that one approved batch has no claimable jobs left, use:

```bash
pnpm collection:work -- --batch-id <approved-batch-uuid> --until-batch-complete
```

This is not an unbounded crawl. The batch has a finite, recorded target set and
keeps its page and error circuit breakers, retry limits, per-domain concurrency,
source-policy gate and robots checks. The flag removes only the arbitrary local
worker job count. It cannot continue into a later batch, because approval for
one release is not approval for another.

For a supervised production host, `pnpm collection:daemon` runs the same
approved-job consumer continuously. It sleeps while no eligible job exists and
resumes when an operator approves a finite batch. It may move between approved
batches, but it cannot create or approve a batch and it still evaluates source
policy before claiming each target. `WORKER_POLL_INTERVAL_MS` controls the idle
poll interval from 1 to 60,000 milliseconds.

The Render Blueprint runs one daemon in Oregon, disables automatic deploys, and
uses a 300-second graceful shutdown window. `DATABASE_URL`,
`CRAWLER_USER_AGENT`, and `CRAWLER_CONTACT_URL` remain dashboard-managed
secrets. A `SIGINT` or `SIGTERM` stops new claims; the active job completes and
the database pool closes before the process exits.

The worker database pool defaults to 10 connections. The dedicated Supabase
project's session pool admitted 12 simultaneous worker connections and refused
an attempted twentieth connection at its 15-session plan ceiling. Keep one
worker at the default pool size so administrative and health connections retain
headroom.

Running that command performs live requests. It therefore requires explicit
human approval for that exact batch every time, in addition to cleared source
policies and all remaining production blockers. Do not use it for local fixture
testing.

The browser console remains a local review surface, not production
authentication. It is separate from the read API authentication callback and
does not make the local console a public service.

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

`pnpm local:setup` runs the same scenario with `--persistent`, retaining the
database under the ignored `storage/` directory for the local operator console.
It is separate from the `DATABASE_URL` used by the CLI and migration command.

## Database

```bash
docker compose up -d postgres
pnpm db:migrate                      # apply pending migrations
pnpm db:migrate -- --check           # validate the files, no database needed
pnpm db:migrate -- --rollback 0005   # revert down to and including 0005
```

### One authoritative migration system

**Supabase owns production migration state.** The SQL in `supabase/migrations`
is the source of truth, and Supabase applies it to the production project. The
runner in `packages/database/src/migrations.ts` is a **local development and
test harness** that applies the same SQL to a local or in-process PostgreSQL. It
keeps its own `schema_migrations` bookkeeping for that purpose and must never be
pointed at the production database, because two systems recording what has been
applied is how environments diverge without anyone noticing.

Each migration and its bookkeeping row commit in **one transaction**. PostgreSQL
has transactional DDL, so a migration that fails halfway leaves nothing behind
rather than a partly-changed schema that the next run replays into a second,
unrelated error.

The down scripts in `supabase/migrations/down/` are **test utilities**. They
exist so the migration test can roll the schema down and back up, which is how a
missing drop gets caught. They are not an operational rollback procedure: the
answer to a bad shipped migration is a new migration.

The runner records a checksum per migration and refuses to run when an applied
one has been edited: the fix for a shipped migration is a new migration, never a
rewritten one.

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

Two review queues exist in the repositories and have no CLI command yet:
`OrganizationRepository.identityReviewQueue()` lists organizations whose
identity was too weakly evidenced to be sure, and
`ComplianceRepository.complaintReviewQueue()` lists complaints that could not be
matched uniquely to a person or whose suppression transaction failed. Complaint
delivery retries must reuse the original idempotency key; the durable complaint
is resumed rather than duplicated. Both queues are worked by a person.

`coverage` takes an optional government level and sector, so
`pnpm admin coverage education` and `pnpm admin coverage federal` are separate
questions with separate denominators.

`apps/api` serves `/health`, `/coverage` and `/records`. It is read-only: it
rejects every method other than GET, and has no route that sends, exports around
suppression, or mutates anything. Every data route requires the authenticator
provided by its production entry point. Record reads also accept only an active,
human-approved purpose from `export_purposes`; none is created implicitly.

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

Crawling runs in the Node worker, never in an orchestrator. n8n, if used, would
start jobs and receive completion events over webhooks; it would not fetch
pages.

`N8N_WEBHOOK_URL` is named in `.env.example` and **nothing reads it**. No code
path posts a webhook. The same is true of any other variable in
`.env.example` that this documentation does not show being read: naming a
variable is not wiring it.

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
