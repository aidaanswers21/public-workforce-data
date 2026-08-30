# Backlog

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
