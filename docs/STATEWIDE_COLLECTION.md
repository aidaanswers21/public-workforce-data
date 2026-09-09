# Statewide collection

Use **Collection projects → Collect by state** to select one or more states and
one or more organization rosters. The education sector supplies district and
school rosters; both are selected by default. This uses the already loaded
national release. It does not download a new official release or contact a site.

Preparation resolves exact official identifiers in bounded transactions, creates
one project across the selected states and government levels, and generates
website targets. An organization whose identity, type and sector are published
can be collected while its government level remains null. Its source row keeps
its classification hold and reason. No government level is guessed. Missing
identities, conflicting identifiers and missing websites remain exceptions.
Published parent relationships are materialized separately from classification.

The preparation screen lists the actual source URLs and policy decisions. Review
missing policies individually or enter bulk decisions, one line per reviewed
domain: `domain | what you checked`. A bulk submission records a separate review
and approval on each source row under the signed-in operator's identity. It does
not claim that an unknown policy permits automation, commercial use or solicitation.
Prohibited sources cannot be approved through this path. URL-specific policies
continue to take precedence over domain decisions.

**Start collection** authorizes discovery and extraction together for the
snapshotted organizations, until the UTC expiry (at most 31 days) or the run's
request/error limits. Source policy is still checked for every request. The
legacy separate discovery and crawl batch controls remain available for diagnostics.
Internal work is no longer restricted to 1,000 targets, and newly discovered
directories enter the same run automatically. Organizations added to the project
later are not added to an existing run's authorization.

A policy hold does not prevent other eligible domains from running. After recording
bulk source decisions, eligible held jobs can resume under their original run,
provided it has not expired, been cancelled or exhausted its budget. This never
creates standing authorization for future runs.

## Discovery and extraction

Discovery inspects ordinary navigation before trying to select a directory
adapter. It follows directory links, intermediate navigation and sitemap entries
within the seed's registrable domain, bounded by depth, requests and frontier size.
It selects the extraction adapter on the actual directory page and saves its
frontier after each processed page. A 403 is blocked; a retryable server failure
remains a failure. Neither becomes a fictitious completed page.

Generic HTML combines structured, table, card and definition-list results with
deduplication, using mailto heuristics only when stronger strategies find nothing.
Generic JSON continues to support pagination. Public phone extensions are retained.
A shared directory has separate links to all associated organizations. Extraction
uses exact published organization names to assign records when multiple scoped
organizations share it. Ambiguous assignments remain archived evidence and are
reported as partial collection instead of being assigned to an arbitrary employer.

Optional browser rendering handles public JavaScript content. Install Chromium:

```bash
pnpm --filter @public-workforce/crawler-worker exec playwright install --with-deps chromium
```

Set `CRAWLER_RENDER_BROWSER=true` on the worker to enable it. Browser requests go
through the same source-policy checks, robots checks, domain scope, serialized
transport, pacing, request budget and response archive. Service workers and
WebSockets are disabled. Images, fonts and media are not fetched. The raw response
and the rendered document are archived separately. Login and challenge pages are
not bypassed. An unapproved external script/API remains an exception; browser
rendering does not grant permission to contact new domains.

There are no platform-specific adapters yet. Rendering is not a guarantee that a
search-only directory can be fully enumerated. Coverage is measured from actual
results, and missing, blocked, partial and empty outcomes remain visible.

## Worker operation

`pnpm collection:daemon` consumes only approved work. `WORKER_CONCURRENCY` controls
parallel jobs across independent domains, defaults to 4, and is capped at 10.
Each domain has one active database claim. Claims renew while executing; requests,
checkpoints and ingestion check ownership. An expired or cancelled claim cannot
start a new request or complete a job. Continue-until-complete waits for temporarily
unclaimable jobs rather than treating another worker's domain lock as completion.

For full collection runs, each guarded transport attempt, including redirects,
retries and browser resource requests, is charged before transport against the
shared run and target budgets. Robots retrieval uses its separate cached provider;
it is not included in the content-request count. This differs from legacy batch
page accounting. A budget stop is a partial result, not complete directory coverage.
The configured crawler identity is used for robots matching and requests.

Existing deployments must apply migration 0020 and deploy the updated application
and worker before using this workflow. Remote migrations and deployment remain
separate operator actions. Browser-enabled deployments also need Chromium and its
system libraries. Rollback refuses if new nullable classifications or duplicate
per-kind jobs cannot fit the previous schema; reconcile or remove only the specific
new run data under an approved rollback plan before reverting.

## Export and coverage

**Coverage and exceptions** lists every selected organization in pages of 100,
including missing websites, policy holds, active work, partial results, stored
people and published email counts. Counts are observations, not promises that an
organization publishes every employee's contact details.

**Exports → Download the complete collection** streams the complete result in
chunks of 2,000 assignments with a stable assignment cursor and a creation-time
cutoff. It avoids the old 50,000-row limit and does not hold the whole CSV in memory.
The optional limited download remains for samples. The CSV includes all eligible
published emails and public work phone values alongside the preferred email,
name, role, department, organization and provenance columns. Inferred candidates
remain in their own column. Contacts with only a published work phone are retained.
Source-suppressed contact points are excluded.

Each chunk is filtered in SQL and rechecked in memory immediately before writing.
The complete export records its total row count and checksum. A disconnected
stream is marked failed. Downloads are fresh streams, not stored asynchronous
artifacts; retrying starts a new export. Concurrent edits to existing assignments
may be visible on subsequent chunks, while later-created assignments are excluded.
