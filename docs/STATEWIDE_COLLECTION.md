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
During collection preparation, conflicting existing identities or classifications
move to a reconciliation hold with their original evidence and a recorded reason.
Other records continue through preparation, including when an entire internal
chunk consists of conflicts. The standalone strict import retains its refusal
behavior. The preparation screen counts source records that remain unlinked.
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

## Separate organization websites

Each published website URL has its own discovery job and resulting directory jobs.
For education, this keeps a district's central-office directory separate from each
school's staff directory. Each job retains its own checkpoint and target request
allowance; the state run still shares its overall approval and request budget.
Completion or an access block on one site does not mark another site's work complete.

Jobs stay on the organization's published website host (allowing its www alias)
and, for nested websites, its path prefix. Published websites for other organizations
on that host establish exclusions, including organizations outside the approved
roster. Thus a district job skips a known school subdirectory, and a school job
skips district-wide navigation and sibling sites. A subdomain is a separate website,
even when it shares the same registrable domain. The existing domain lock still
paces jobs sharing that domain. Scoped sitemap probes stay within the website path.
Redirects are checked before parsing; the production transport checks every redirect
before fetching it. Website query identifiers are retained as scope constraints.

Select the district and desired schools in the roster so each published site has
its own job. Links to unselected organizations do not expand an approved run. A
missing school website remains a website-resolution exception; do not substitute
the district homepage. An identical shared website URL still has one deduplicated
fetch job: explicit published organization names are required to resolve its staff,
and ambiguous rows remain exceptions. Website boundaries cannot identify separate
organizations whose roster records incorrectly publish the same homepage. Shared assets or external hosting
outside this boundary are not fetched by that job and may leave browser-rendered
directories incomplete.

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
Worker failures persist their terminal or retryable state, clear the claim, count
the error and release already-discovered directories into the same approved run.
This includes target-budget exceptions; a database parameter-type conflict must
not leave these jobs stuck until their leases expire.

During a deployment that corrects extraction quality, pause active projects first.
A new deployment being live does not prove the previous worker has stopped.
Confirm the previous instance has stopped (or its full configured shutdown grace
period has elapsed) before resuming. Keep the original batch, roster, expiry,
request counters and checkpoints when resuming.

Existing deployments must apply migrations 0020 and 0021 and deploy the updated application
and worker before using this workflow. Remote migrations and deployment remain
separate operator actions. Browser-enabled deployments also need Chromium and its
system libraries. Rollback refuses if new nullable classifications or duplicate
per-kind jobs cannot fit the previous schema; reconcile or remove only the specific
new run data under an approved rollback plan before reverting.

Migration 0021 indexes exact identifier system/value lookups, with nullable issuing
jurisdictions compared afterward. This prevents relationship preparation from
scanning the whole identifier table again for every organization in a state.

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
