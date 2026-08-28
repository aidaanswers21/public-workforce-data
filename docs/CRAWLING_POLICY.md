# Crawling policy

## Scope

Only information available without authentication, from official government,
district and school websites. Nothing else.

The crawler must never:

- collect student information of any kind;
- attempt to bypass authentication, a CAPTCHA, or any technical restriction;
- retry harder against a source that has refused us;
- follow links onto a domain the run was not scoped to.

A source that blocks us is recorded as blocked and left alone. That is the whole
response. `HttpFetcher` treats 401, 403 and 429 as non-retryable refusals, and
`CrawlEngine` stops the target and records `blocked_by_source` the moment a
page contains a human-verification challenge.

## Identification

Every request carries a `User-Agent` that names the crawler and links to a page
explaining what it does and how to ask to be removed. Set it per deployment via
`CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_URL`; the default in
`DEFAULT_CRAWL_POLICY` points at `example.invalid` precisely so an unconfigured
deployment is obvious rather than anonymous.

## robots.txt

`HttpRobotsProvider` fetches and caches robots.txt per origin and parses
User-agent grouping, Allow, Disallow (with `*` and `$`) and Crawl-delay, with
longest-match precedence. A disallowed path is not fetched: the engine records a
`robots_disallowed` error, notes `blocked_by_robots` and stops that target. An
unreachable robots.txt is treated as permissive, and the outcome is recorded
either way so the policy log shows what we saw rather than what we assumed.

A `Crawl-delay` longer than our configured delay wins.

## Limits

Defaults in `DEFAULT_CRAWL_POLICY`, all overridable per state:

| Setting                           | Default | Purpose                                      |
| --------------------------------- | ------- | -------------------------------------------- |
| `requestDelayMs`                  | 1500    | Minimum gap between requests to one domain   |
| `maxConcurrencyPerDomain`         | 1       | One request at a time per domain             |
| `maxPagesPerRun`                  | 250     | Hard ceiling on a run                        |
| `maxPagesPerDomain`               | 250     | Hard ceiling per domain                      |
| `maxDepth`                        | 4       | Stops a directory walk becoming a site crawl |
| `maxConsecutiveFailuresPerDomain` | 5       | Circuit breaker                              |
| `maxPagesWithoutNewRecords`       | 3       | Stops fruitless pagination                   |
| `maxRetries`                      | 2       | Transient failures only                      |
| `requestTimeoutMs`                | 20000   |                                              |

Texas overrides `requestDelayMs` to 2000 and `maxPagesPerDomain` to 150: many
districts touched lightly, rather than one touched heavily.

## Guards

`CrawlGuards` enforces, and every stop is recorded on the run:

- `page_budget_exhausted`, `domain_budget_exhausted`, `depth_limit`
- `pagination_loop` for a sequential pager that revisits a page already
  followed, including a cycle back to the seed
- `duplicate_content` when a body hashes identically to one already fetched
- `no_progress` after N consecutive pages producing no new people
- `empty_success` when a page parses cleanly and holds nobody, which
  distinguishes an empty directory from a broken adapter
- `repeated_failures`, `blocked_by_robots`, `blocked_by_source`

Numbered pagers and filter lists legitimately link backwards, so a repeat there
is a duplicate to skip, not a loop. Only sequential pagination (next link,
cursor, load-more, infinite scroll, offset, page parameter) treats a revisit as
a cycle.

## Exclusions

`DEFAULT_URL_EXCLUSION_PATTERNS` keeps the crawler out of calendars, news and
press archives, athletics schedules, tag and category pages, login and portal
paths, menus, galleries, stores, binary files and anything with a date
parameter. Calendars matter most: they generate an effectively unbounded
paginated URL space and are the classic way a directory crawl becomes an
unbounded one.

States add their own via `extraUrlExclusions`, and `domainDenyList` records
domains never to crawl, each with a reason.

## Cross-domain

A run may only fetch the seed's registrable domain unless `allowedDomains` says
otherwise. `.k12.<state>.us` is handled correctly, so `staff.sample.k12.tx.us`
and `sample.k12.tx.us` are the same site.

## Storage of raw responses

`source_pages.storage_key` is where an archived raw response belongs, in
S3-compatible object storage such as Cloudflare R2. The column and the plumbing
exist; the uploader is in `BACKLOG.md`. Nothing is archived today.

## Running a real crawl

Not done during repository construction, and not done from a developer machine
without a decision to do it. `pnpm crawl:fixture` runs the entire pipeline
against saved fixtures with no network access. Before any live run:

1. Confirm the state's official sources are marked verified.
2. Set a real `CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_URL` with a reachable
   policy page.
3. Start with a small approved sample of targets, not a state.
4. Read the failure breakdown (`pnpm admin failures`) before widening.
