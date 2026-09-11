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

Set `CRAWLER_RENDER_BROWSER_DOMAINS` to a comma-separated list of explicitly
selected approved exact hostnames, such as `directory.district.example.gov`.
Subdomains must be listed separately; schemes, ports, paths and wildcards are
rejected. Empty or unset means rendering is off. This is only a transport
selection. It does not approve the source or expand the job's domain scope.

Browser requests go through the same source-policy checks, robots checks, domain
scope, serialized transport, pacing and response archive. Only the top-level
directory page consumes the campus page budget. Optional script and API
subresources use a separate guarded transport; a disallowed third-party resource
is aborted without failing the approved main page. Service workers and WebSockets
are disabled. Images, fonts and media are not fetched. The raw response and the
rendered document are archived separately. Login and challenge pages are not
bypassed. Browser rendering does not grant permission to contact new domains.

`CRAWLER_RENDER_BROWSER_MAX_SUBRESOURCES` defaults to 50 attempts per page and
`CRAWLER_RENDER_BROWSER_DEADLINE_MS` defaults to a 20,000-millisecond browser
phase. Production accepts maxima of 250 and 60,000 respectively. Requests beyond
the cap and routes still active at the deadline are aborted. A deadline returns
the already fetched static page, so one script cannot hold the durable job open
indefinitely. These browser limits do not change the approved campus page budget.

The Render worker Blueprint performs this Chromium installation during its
build, exposes the dashboard-managed domain list and fixes
`WORKER_CONCURRENCY=1`. Chromium increases build time and image size for every
worker build, but browser memory is used only for matching jobs. Monitor the
Starter worker for out-of-memory restarts before increasing concurrency. A larger
paid worker plan may be required for heavier rendered directories. The work
queue, leases and checkpoints live in PostgreSQL; this deployment does not use
Redis or Render Key Value.

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

For full collection runs, each top-level guarded page transport attempt,
including redirects and retries, is charged before transport against the shared
run and target page budgets. Browser script and API subresources are guarded,
paced and archived but do not consume the campus page allowance. Robots retrieval
uses its separate cached provider; it is not included in the content-request
count. This differs from legacy batch page accounting. A budget stop is a partial
result, not complete directory coverage. The configured crawler identity is used
for robots matching and requests.
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
separate operator actions. The Render Blueprint installs Chromium and its system
libraries during the worker build. Other browser-enabled deployment environments
must install them separately. Rollback refuses if new nullable classifications or duplicate
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

## Fixture browser in CI

CI downloads the Chromium revision selected by the locked Playwright dependency
without refreshing system package repositories. The browser fixture tests still
launch Chromium, so missing runtime libraries fail CI. This avoids an unrelated
system-package mirror preventing all verification before tests can start.
Standalone Linux deployments still need the browser and its system libraries as
described above.

## Viewing collected contacts

Open **Collection projects**, choose a project, then **View contacts**. The same
link is available beside each project's extracted-record count. The contacts page
shows published names, organizations, titles, departments, work emails, work phones,
and source links. Search by name, organization, title, or preferred published email;
use **Next contacts** to continue beyond the first 100 assignments.

Contacts are scoped to the project's organization membership, so an organization
already collected in another project can have visible contacts before this project
runs. Extracted records count observations, including repeats; they are not a count
of unique people or email addresses. The list shows active assignments with visible
published contact details, including general inboxes, and excludes inferred addresses.
Suppression is checked in SQL and again before rendering for internal review.
Viewing existing contacts does not start a crawl or require an export purpose.

**Download CSV** opens Exports with the current project selected. File downloads
retain the existing purpose approval, confirmation, audit, and suppression checks.
An empty results page explains how to clear search and open coverage and exceptions.

## Individual staff profiles and a compact contact file

Production collection follows the individual profile links a directory publishes.
Profile requests share the job's website boundary, source policy, robots checks,
request budget, and checkpoints. A plain directory containing only named links can
now create profile work, including opaque URLs such as `/pages/17`. A single named
main profile can supply its published email without structured markup. Navigation
and footer inboxes cannot supply the profile's email; ambiguous multi-person pages
are not treated as one profile. Empty or duplicate individual profiles do not stop
the remaining profile queue. Pagination loop and no-progress guards continue to
apply to listing pages; all profile requests still consume the run budget.

The default selection on the download form is a five-column file:
`first_name,last_name,email,organization,source_page`. For a school-scoped project,
organization is the school. Each row contains one published email and the actual
page that published that email, even when the person's name was first encountered
on a directory index. Null name parts remain blank. Inferred addresses and
phone-only records are absent from this compact file. Repeated assignments do not
repeat the same email within an organization, including across download chunks. Published general inboxes
remain opt-in. Full contact and provenance exports remain available from the
Columns menu. Both formats retain SQL filtering and the final suppression recheck.

A school roster entry that repeats a district homepage is not evidence of a
school-specific staff directory. Such entries require website resolution; they
must not be presented as a completed school collection or assigned district staff.
