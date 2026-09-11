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
database URL, the crawler identity and private S3-compatible archive
credentials. `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`,
`STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` are all required. A
supervised run may use a local job ceiling:

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

When a batch encounters an unreviewed domain, the worker makes no request and
moves that job to `policy_hold`. The project page lists each held domain with an
external inspection link and a prefilled policy-review action. After a person
records the decision, the operator must approve a new finite batch. The failed
batch remains immutable audit evidence and never retries itself.

The Render Blueprint runs a private operator web service and one daemon in
Oregon on Starter instances, with automatic deploys disabled. The web service
has a 30-second shutdown window and `/health` returns success only when its
database connection is ready. The worker uses a 300-second graceful shutdown
window. Its build installs the Chromium revision selected by the locked
Playwright dependency. Browser rendering remains off unless
`CRAWLER_RENDER_BROWSER_DOMAINS` contains the approved job's exact hostname; it
does not run Chromium for other jobs. `WORKER_CONCURRENCY=1`
keeps only one browser-backed crawl job active on the Starter worker.
`DATABASE_URL`, admin credentials, `CRAWLER_USER_AGENT`, and
`CRAWLER_CONTACT_URL` remain dashboard-managed
secrets. The worker also requires the five `STORAGE_*` values named above. Both
services use Supabase's published production root certificate from
`config/certificates/supabase-prod-ca-2021.crt` so the session-pool connections
retain full certificate and hostname verification. A worker `SIGINT` or
`SIGTERM` stops new claims; the active job completes and the database pool
closes before the process exits.

The durable claim queue and checkpoints are stored in PostgreSQL, so this
deployment does not require Redis or Render Key Value. Chromium increases build
time and image size even when no rendering domains are configured. It increases
peak worker memory only for the explicitly selected jobs. Concurrency one is the
conservative Starter-plan setting: it reduces throughput, but avoids multiple
browser processes competing for the same memory. Monitor memory and
out-of-memory restarts during the first approved rendered batch; moving to a
larger paid worker plan may be necessary before raising concurrency.

Each rendered page is also bounded to 50 script, stylesheet and API subresource
attempts and a 20-second browser phase. The Blueprint exposes those limits as
`CRAWLER_RENDER_BROWSER_MAX_SUBRESOURCES` and
`CRAWLER_RENDER_BROWSER_DEADLINE_MS`; production validation caps them at 250 and
60,000 milliseconds. Excess or late routes are aborted. If the deadline expires,
the worker uses the already fetched static page instead of waiting indefinitely.

The worker database pool defaults to 10 connections. The dedicated Supabase
project's session pool admitted 12 simultaneous worker connections and refused
an attempted twentieth connection at its 15-session plan ceiling. Keep one
worker at the default pool size so administrative and health connections retain
headroom.

Running that command performs live requests. It therefore requires explicit
human approval for that exact batch every time, in addition to cleared source
policies and all remaining production blockers. Do not use it for local fixture
testing.

### Hosted operator console

The hosted console runs the same neutral project and policy workflows against
managed PostgreSQL. It is a private single-operator application, not the read
API's authentication system. Render terminates HTTPS and the application:

- refuses to start without `DATABASE_URL`, `ADMIN_EMAIL`,
  `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, and an HTTPS public origin;
- accepts a scrypt password hash, never a plaintext hosted password;
- signs an eight-hour `HttpOnly`, `Secure`, `SameSite=Strict` session cookie;
- validates same-origin request metadata on every state-changing request,
  including a same-host fallback for browsers that omit `Origin`;
- throttles repeated failed logins and sends HSTS and restrictive browser
  security headers; and
- exposes only database readiness at `/health`, with no records or credentials.

`RENDER_EXTERNAL_URL` supplies the expected origin by default.
`ADMIN_PUBLIC_ORIGIN` is only needed for a later custom domain. Use a dedicated
database login for the console and grant only the reads and project/source-policy
writes its repositories require. Do not reuse the worker login: the worker and
console credentials must be independently revocable.

The Starter plan prevents free-tier idle suspension. Render health checks and
process supervision recover a failed process, but they do not repair a bad
release or an unavailable database. Keep deploys manual, verify `/health` after
each release, and use Render's previous deployment rollback if a new release
fails. Rotating a database password requires updating every service that uses
that login before redeploying it.

The **Exports** page creates controlled purposes and downloads a CSV for one
selected collection project. Creating a purpose and producing a file each
require an explicit signed-in confirmation. The repository rejects inactive or
unknown purposes, supports a limited sample or a complete streaming download, applies suppression in
SQL, re-checks it immediately before rendering, and records the export checksum
and audit event. This repository does not send the file or perform outreach.

The staff-directory CSV is one row per published work email. It includes the
published and parsed name, assignment title and department, organization and
direct parent, organization website, role taxonomy, specialty, duty location,
and email-specific source URL, timestamps, classification, validation and
provenance. It never includes inferred candidates. General office inboxes are
excluded unless the operator explicitly includes them. The compact contacts and
full audit-oriented formats remain available.

For imported accepted-contact artifacts, the displayed source URL comes from
the allowlisted per-record `source_page_url` observation, while the source
document and version columns continue to identify the archived artifact that
provided the evidence. Only allowlisted import metadata is flattened: dataset,
file, line, QA identity method, grade range, organization website, location and
email-source description. Raw source context is never exported. Duplicate rows
are keyed by person, organization and email. If the same organization and email
are attached to different people, both rows remain visible with
`email_identity_conflict=true` for review.

The selected collection project's jurisdiction configuration may name a
role-category flag and its CSV header. The neutral export path applies that
configuration without knowing the vertical. Texas education configures the
staff-directory download as `is_teacher`, derived from the normalized role
category, and imported grade metadata is supplied through the allowlisted
`grade_range_published` observation.

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

| Stop                       | Meaning                                  | Action                                                                                                      |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `completed`                | The frontier emptied                     | None                                                                                                        |
| `blocked_by_source_policy` | No approved policy for the source        | Review and approve the source, or leave it alone                                                            |
| `empty_success`            | Page parsed, nobody on it                | Check whether it is JS-rendered, the wrong adapter, or missing vocabulary                                   |
| `no_progress`              | Pages stopped yielding new people        | Usually correct; check the pager if unexpected                                                              |
| `pagination_loop`          | A sequential pager revisited a page      | Adapter or site issue; check the fixture                                                                    |
| `duplicate_content`        | A body hashed the same as an earlier one | Usually a pager returning the same page                                                                     |
| `page_budget_exhausted`    | Hit a checkpoint slice or hard ceiling   | The worker resumes within the approved target ceiling; otherwise raise it deliberately or narrow the target |
| `blocked_by_robots`        | robots.txt disallowed the path           | Respect it. Do not work around it                                                                           |
| `blocked_by_source`        | 401/403/429 or a challenge page          | Respect it. Record it and move on                                                                           |

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

Large directories remain one durable job and crawl run. The worker saves the
page's normalized records and provenance before advancing its frontier, then
releases a healthy job after each 250-page slice. Another lease can resume it
without refetching earlier pages, and a process death cannot strand records
behind an advanced checkpoint. A job is not marked complete while its checkpoint
still has pending tasks. Continuations are bounded by the approved target ceiling
and run expiry; hard budget exhaustion is recorded as partial failure rather than
retried forever. Ingestion errors, boundary drops and collected-record counts are
carried in the checkpoint across slices, so the final run and batch status reflect
the whole crawl rather than only the last lease.

`N8N_WEBHOOK_URL` is named in `.env.example` and **nothing reads it**. No code
path posts a webhook. The same is true of any other variable in
`.env.example` that this documentation does not show being read: naming a
variable is not wiring it.

## Cost

The Blueprint uses paid Starter compute for the web service and worker. Browser
rendering adds no separate Playwright or Chromium license fee, but its higher
memory use can require a larger worker plan. PostgreSQL and private object
storage also have provider-specific hosting costs. No Redis or Render Key Value
instance is required. The only optional per-address application provider is
email validation, and the default is a no-op that cannot spend anything.
`ValidationProviderInfo.billable` marks a provider that bills per address, and
`email_validation_results` records the provider and request id per check so
spend is attributable.

## Before a production crawl

See `CRAWLING_POLICY.md` and `SOURCE_POLICY_REVIEW.md`. In short: verified
sources, approved source policies, a real user agent with a reachable policy
page, a small approved sample first, read the failures, then widen. Not before.

For multi-state roster preparation, full collection runs, browser installation,
worker concurrency, and streaming exports, see `STATEWIDE_COLLECTION.md`.

## Replaying legacy Texas contact exports

Legacy accepted-contact NDJSON can be checked without pretending that it is a
saved web page:

```bash
DATABASE_URL=... pnpm texas:legacy-contacts -- ./legacy-contact-manifest.json
```

The manifest has `schemaVersion`, a stable `artifactId`, a truthful artifact
`createdAt`, a separate latest-source `contentCutoffAt`, the `texas-education`
jurisdiction, and one or more `{ path, sha256 }` file entries.
Inputs may be `.jsonl` or streaming `.jsonl.gz`; compressed artifacts are
recorded as `application/gzip`. The default is a dry run. It verifies each file's
hash, exact-matches the published district and school pair to the organization
spine, and writes separate quarantine and revalidation NDJSON files. Personal,
malformed, inferred, unnamed, out-of-state, unmatched, and ambiguous rows never
enter the people tables. A checkpoint is replaced atomically after each line,
so the same command resumes rather than starting the file over.

`--seed-revalidation` creates idempotent pending crawl targets for the accepted
rows' human-viewable directory URLs. It does not run those targets. A live crawl
still needs the normal source policy and approved-run gates.

`--apply` imports accepted rows as `file_import` evidence. Every manifest file
must then include either an `archiveStorageKey` for a private durable copy or an
immutable GitHub git-blob API `archiveUrl`. Canonical person, assignment, and
email rows cite that archived accepted artifact, so a source suppression applies
to every imported row. A paired `source_page_url` observation retains the
human-viewable directory page for each record and email without manufacturing a
web-page version that was never captured. Separate typed observations retain
the safe import fields. Replaying the same checksummed manifest is idempotent.

The manifest also binds the originating workbook checksum and a deterministic
approved-domain allowlist checksum. Import refuses a directory URL outside that
allowlist, even when the district and school names match exactly.

For a one-time hosted import when the worker has no interactive shell, set the
collector's non-secret `STARTUP_LEGACY_CONTACT_IMPORT_ARTIFACT_ID` environment
variable to the manifest's exact `artifactId`. The worker start command runs the
startup importer before the crawl daemon. An absent or empty value disables it;
boolean-like values and IDs for any other artifact fail closed.

The startup path verifies the manifest, accepted artifact hash, approved-domain
allowlist hash, durable archive reference, every row, and every exact
organization match before its first write. It does not create quarantine or
checkpoint files. Instead, it counts the artifact's append-only
`legacy_artifact_id` observations in PostgreSQL. A matching count skips an
already completed import, while an interrupted import safely replays
idempotent batches and verifies the same database count before the crawler may
start. Partial restarts load only the completed record keys for that exact
artifact and skip them instead of replaying their writes. The worker logs
aggregate preflight and import progress without names, emails, or other row
content. After a successful import, remove the environment variable and redeploy
so ordinary restarts do not spend time re-reading the bundle.

The bundle's organization website, campus location label, city, county, state,
and grade range fields come from the exact matched row of that approved
workbook. `location_published` is the canonical campus name because the source
workbook contains no street-address field. Missing workbook values stay empty.

The checked Texas bundle is in `data/texas/legacy-contacts`. It contains 96,077
production-accepted rows from Batch 1 and Batch 2, a ten-row fixture, its
deterministic builder, approved-domain allowlist, summary, checksums, and the
ready-to-run manifest. One malformed address retained in the immutable source
artifact is excluded by exact line hash. No quarantined contact rows are checked
into that directory.

Rebuild it only from the approved workbook and audited inputs, supplying the
actual artifact creation time explicitly. Reuse the same value only when
reproducing the same artifact bytes:

```bash
python data/texas/legacy-contacts/build_import_bundle.py \
  --workbook /path/to/TX_School_Websites_by_Location.xlsx \
  --batch1 /path/to/staff_records.jsonl \
  --batch2 /path/to/accepted_records.jsonl \
  --output data/texas/legacy-contacts \
  --artifact-created-at 2026-09-11T19:29:39Z
```

After the accepted artifact is imported, prepare the remaining school websites
inside an existing Texas education collection project with a dry run first:

```bash
DATABASE_URL=... pnpm texas:seed-uncovered-campuses -- \
  data/texas/legacy-contacts/legacy-contact-manifest.json \
  <collection-project-uuid>
```

The plan counts schools as covered only when that school has a person carrying
this manifest's exact `legacy_artifact_id` observation. Before applying, it
verifies the checksummed artifact files and refuses to seed unless PostgreSQL
contains exactly the same number of observations for that artifact. It rejects missing or malformed
websites and every hostname outside the checksummed workbook allowlist. Applying
the plan requires `--apply --actor <operator>` and creates only idempotent
`pending` organization-site targets with the website source document as
provenance. It does not create or approve a batch, approve a source policy,
enqueue work, start a worker, or contact a website. Review the resulting source
manifest and use the normal finite-run approval screen before collection.
