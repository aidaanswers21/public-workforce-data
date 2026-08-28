# Backlog

Ordered roughly by what unblocks the most. Nothing here is started.

## Blocking a real Texas run

- **Verify the Texas official sources.** Open each URL in
  `packages/state-config/texas/src/index.ts`, confirm it resolves and is
  current, download the file, confirm the column names, set `verified: true`.
  Until this is done the importer refuses to run.
- **Run the institution import and reconcile counts.** District and campus
  totals against TEA's published figures; distinct counties against 254.
- **Raw response archiving to R2.** `source_pages.storage_key` is plumbed but
  nothing writes it. Needed before a real crawl, so a disputed record can be
  checked against what the page actually said.

## Data quality

- **Model organizational contacts separately.** A "Front Office" row currently
  becomes a person with a `general_inbox` address. The classification is right,
  the person row is not. Needs an `organization_contacts` table and a branch in
  the pipeline.
- **Grow the title rule table** from `pnpm admin titles` output. Titles outside
  it become `other` at 0.2 confidence.
- **Department resolution.** `departments` exists and `department_id` is always
  null: the pipeline does not yet resolve a published department string to a row.
- **Employment history.** An assignment that disappears from a source is not
  marked inactive; nothing sets `status = 'inactive'` today.
- **Fuzzy institution matching**, behind a review queue. Deliberately absent
  now: silent fuzzy matching is worse than a visible unmatched count.

## Crawling

- **Browser rendering** behind `requiresBrowser`, using PlaywrightCrawler. Needed
  for JavaScript-rendered directories, which currently show up as
  `empty_success`.
- **Parallel targets.** The engine walks one target at a time. Per-domain limits
  already exist; a scheduler across domains does not.
- **Resume from stored checkpoints.** `crawl_checkpoints` is written and
  readable, and the engine accepts `resumeFrom`, but no worker loop reads a
  checkpoint back on restart.
- **Platform-specific adapters**, once discovery shows which real platforms
  recur. Not before.

## AI extraction

Unimplemented and gated. If added, it must: require a strict JSON schema;
cache by content hash; store model, prompt version and cost; never invent
people, titles, schools or emails; route low-confidence output to review; keep
the original source content; and be a last resort after deterministic HTML and
JSON extraction have both failed.

## Validation

- **A real provider implementation** behind `EmailValidationProvider`. The
  interface, batching and promotion rules are done; no vendor is wired in.
- **Bounce feedback** into `suppression_entries` with source `bounce`.

## Admin

- The full dashboard described in the brief: state progress, per-district
  counts, directories discovered, crawled, published personnel, published
  emails, inferred candidates, validated, suppressed, failed sources,
  unsupported platforms, last crawl date, estimated cost, data-quality samples.
  Today: a CLI and a read-only JSON API covering runs, failures, coverage,
  samples and unmatched titles.
- Export download UI, going through `ExportRepository` so suppression is
  enforced.

## Platform

- **Postgres repositories for the remaining tables.** The ingestion, crawl,
  compliance, query and export paths are implemented. Direct repositories for
  `counties`, `departments`, `directory_platforms` and `domain_email_patterns`
  are partly inline SQL.
- **n8n webhooks** for job start and completion.
- **CI against a real Postgres service container**, in addition to the
  in-process one.
- **Structured metrics export.** `MetricsCollector` counts in process and is not
  shipped anywhere.
