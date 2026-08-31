# Backlog

## Production blockers

Findings from the independent architecture review that are **not** implemented
in this change. Each one blocks something specific, and the thing it blocks does
not happen until it is resolved. Owner is the human repository owner in every
case: a model may propose and implement, and only a person may accept.

**No live source may be fetched and no real outreach export may be used until
the applicable blockers below are resolved.**

### C12: production source-policy wiring

- **Risk.** The source-policy gate is enforced in `CrawlEngine`, but nothing
  loads real policy rows into it at run time, and no operator command records a
  review or an approval. A production run today would gate against an empty
  registry, which refuses everything or, if `allowUnreviewedSources` were set,
  permits everything.
- **Required resolution.** Load `source_policies` into the registry at job
  start; add admin commands to record a review and a production approval; fail a
  run whose targets include a domain with no policy row.
- **Required tests.** A run refused for an unreviewed domain; a run permitted
  after an approval is recorded; a prohibited row that no approval can unblock.
- **Status.** Not started. **Blocks live crawl.**

### C13: discovery-worker policy and robots enforcement

- **Risk.** The discovery worker fetches organization sites to find directories.
  It does not go through the source-policy gate, so discovery could reach a
  source the crawler itself would refuse.
- **Required resolution.** Route every discovery fetch through the same gate and
  the same robots provider as the crawl engine.
- **Required tests.** Discovery refuses an unapproved domain; discovery honours
  a robots disallow; a refusal is recorded as `policy_hold` rather than an error.
- **Status.** Not started. **Blocks live crawl.**

### C14: API authentication and controlled export purposes

- **Risk.** `apps/api` is read-only but unauthenticated, and any caller may name
  any export purpose. Purpose-scoped suppression is only as good as the purpose
  string being trustworthy.
- **Required resolution.** Authenticate the API; hold declared purposes in a
  controlled table with an owner and an approval; reject an unknown purpose.
- **Required tests.** An unauthenticated request is refused; an unregistered
  purpose is refused; a purpose-scoped suppression is honoured for the purpose
  it names and not for others.
- **Status.** Not started. **Blocks deployment.**

### C15: geographic suppression inheritance

- **Risk.** `geographic_area` suppression matches the areas listed on a row. It
  does not walk up the area tree, so suppressing a state does not suppress the
  counties inside it, which is what an operator would reasonably expect.
- **Required resolution.** Decide the semantics deliberately, document them, and
  either resolve ancestry for geographic areas as `organization_subtree` does
  for organizations, or rename the scope so it cannot be misread.
- **Required tests.** Suppressing a state withholds a person whose duty location
  is a county inside it, or the documentation says plainly that it does not.
- **Status.** Not started. **Blocks outreach export.**

### C16: concurrent audit-chain correctness

- **Risk.** `audit_event_append` reads the last hash and inserts. Two concurrent
  writers can read the same predecessor and produce a forked chain, which
  `verifyAuditChain` would report as tampering.
- **Required resolution.** Serialize appends, with an advisory lock or a
  monotonic sequence the hash covers.
- **Required tests.** Concurrent appends produce a chain that verifies; a
  deliberate tamper still fails verification.
- **Status.** Not started. **Blocks deployment.**

### C17: national-scale ancestry and suppression queries

- **Risk.** `ORG_ANCESTRY_CTE` and the suppression filter are recursive and
  correlated. They are exercised against tens of rows. Nobody has measured them
  against a national organization set.
- **Required resolution.** Load-test both at realistic scale; add the indexes
  the plans want; consider a materialized closure table if the recursive CTE
  does not hold up.
- **Required tests.** A benchmark with a stated row count and a stated budget.
- **Status.** Not started. **Blocks deployment.**

### C18: relationship persistence, cycle prevention and re-observation

- **Risk.** `organization_relationships` refuses a self-reference and nothing
  else. A cycle across three organizations is storable, and the in-memory walk
  is cycle-safe while the recursive CTE relies on the data being acyclic.
  Re-observing a relationship that has ended has no defined semantics.
- **Required resolution.** Reject a cycle on write; define what re-observing an
  ended relationship means and implement it.
- **Required tests.** A three-organization cycle is refused; a relationship that
  ends and is re-observed produces the documented result.
- **Status.** Not started. **Blocks live crawl.**

### C20: real fetch provenance metadata

- **Risk.** The ingestion pipeline records `httpStatus: 200`, `contentType:
'text/html'` and `robotsAllowed: true` as literals rather than from the
  response. Every stored document version therefore carries three fields that
  look observed and are invented.
- **Required resolution.** Thread the real response metadata from the fetcher
  through the crawl result into the pipeline.
- **Required tests.** A non-200 response stores its real status; a robots
  decision stores what was actually decided.
- **Status.** Not started. **Blocks live crawl.**

### C21: checkpointing, budgets, concurrency and robots failure behaviour

- **Risk.** Checkpoints are written and never read back on restart; budgets are
  per run rather than across a resumed run; there is no cross-domain scheduler;
  and an unreachable robots.txt is treated as permissive, which is the wrong
  default for a source that may be refusing us.
- **Required resolution.** Resume from a stored checkpoint; carry budgets across
  a resume; schedule across domains; decide and document the robots-unreachable
  policy, defaulting to refusal for a production run.
- **Required tests.** A resumed run does not re-fetch; a resumed run respects the
  original budget; an unreachable robots.txt refuses in production mode.
- **Status.** Not started. **Blocks live crawl.**

### RLS-1: Supabase row-level security integration test

- **Risk.** Row level security is enabled and forced on every table, and the
  schema-side half is asserted in `packages/database/src/schema.test.ts`. PGlite
  has no `anon` or `authenticated` role and no PostgREST, so no test in this
  repository proves that an anonymous request with a publishable key is actually
  refused.
- **Required resolution.** An integration test against a real Supabase project
  that issues a PostgREST request with the publishable key and asserts it
  returns nothing.
- **Required tests.** The above, per table group, in CI against a throwaway
  project.
- **Status.** Not started. **Blocks deployment.**

Ordered roughly by what unblocks the most. Nothing here is started.

## Blocking a real run, in any jurisdiction

- **Verify the Texas education official sources.** Open each URL in
  `packages/jurisdiction-config/texas-education/src/index.ts`, confirm it
  resolves and is current, download the file, confirm the column names, set
  `verified: true`. Until this is done the importer refuses to run.
- **Review and approve source policies.** Every domain in scope needs a
  `source_policies` row with a recorded review and production approval. The
  crawler refuses production collection otherwise. See `SOURCE_POLICY_REVIEW.md`.
- **Run the organization import and reconcile counts.** District and campus
  totals against the published figures; distinct counties against 254.
- **Raw response archiving to R2.** `source_documents.storage_key` is plumbed but
  nothing writes it. Needed before a real crawl, so a disputed record can be
  checked against what the page actually said.

## Sector and jurisdiction coverage

- **A shipped state-government jurisdiction configuration.** The sector pack and
  the extensibility constructions exist; no state agency configuration ships.
- **A shipped county or municipal configuration.** Same position. The first one
  will show whether the local-government vocabulary is adequate.
- **A shipped federal configuration.** The federal pack ships; a real agency
  configuration does not. Prefer a bulk dataset over crawling where terms allow.
- **Grow the composed title table** from `pnpm admin titles` output, per sector.
  Titles outside it become the fallback at low confidence.
- **Watch for cross-pack title shadowing** as packs grow.
  `tests/title-taxonomy.test.ts` is the place to assert each new resolution.

## Data quality

- **Model organizational contacts separately.** A "Front Office" row currently
  becomes a person with a `general_inbox` address. The classification is right,
  the person row is not. Needs an `organization_contacts` table and a branch in
  the pipeline.
- **Organizational unit resolution.** A published department string resolves by
  normalized name only. Sub-units, renames and abbreviations are not reconciled.
- **Employment history.** An assignment that disappears from a source is not
  marked inactive; nothing sets `assignment_status = 'inactive'` today.
- **Relationship inference from source files.** Where an import file names a
  parent, the relationship is recorded. Where it does not, nothing infers one,
  and there is no review queue for the gap.
- **Fuzzy organization matching**, behind a review queue. Deliberately absent
  now: silent fuzzy matching is worse than a visible unmatched count.

## Crawling

- **Browser rendering** behind `requiresBrowser`, using a Playwright fetcher
  implementing the `Fetcher` port. Needed for JavaScript-rendered directories,
  which currently show up as `empty_success`.
- **Parallel targets.** The engine walks one target at a time. Per-domain limits
  already exist; a scheduler across domains does not.
- **Resume from stored checkpoints.** `crawl_checkpoints` is written and
  readable, and the engine accepts `resumeFrom`, but no worker loop reads a
  checkpoint back on restart.
- **Platform-specific adapters**, once discovery shows which real platforms
  recur. Not before, and only after checking whether the sector vocabulary is
  simply missing the wording.

## Source policy

- **Policy text re-check.** `policy_text_hash` is stored; nothing re-fetches a
  policy page and compares it, so a changed policy is currently noticed only by
  a person.
- **An admin command to record a review and an approval.** Today both are direct
  writes to `source_policies`.

## AI extraction

Unimplemented and gated. If added, it must: require a strict JSON schema; cache
by content hash; store model, prompt version and cost; never invent people,
titles, organizations or emails; route low-confidence output to review; keep the
original source content; record `normalization_method = 'assisted_review'` on
anything it touched; and be a last resort after deterministic HTML and JSON
extraction have both failed.

## Validation

- **A real provider implementation** behind `EmailValidationProvider`. The
  interface, batching and promotion rules are done; no vendor is wired in.
- **Bounce feedback** into `suppression_entries` with source `bounce`.

## Admin

- The full dashboard described in the brief: progress per level and sector,
  per-organization counts, directories discovered, crawled, published personnel,
  published emails, inferred candidates, validated, suppressed, failed sources,
  unsupported platforms, sources on policy hold, last crawl date, estimated
  cost, data-quality samples. Today: a CLI and a read-only JSON API covering
  runs, failures, coverage, organizations, policies, samples and unmatched
  titles.
- Export download UI, going through `ExportRepository` so suppression is
  enforced.

## Platform

- **Postgres repositories for the remaining tables.** The organization,
  ingestion, crawl, compliance, query and export paths are implemented. Direct
  repositories for `directory_platforms` and `domain_email_patterns` are partly
  inline SQL.
- **n8n webhooks** for job start and completion.
- **CI against a real Postgres service container**, in addition to the
  in-process one.
- **Structured metrics export.** `MetricsCollector` counts in process and is not
  shipped anywhere.
