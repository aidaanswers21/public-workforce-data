# Crawling policy

## Scope

Only information available without authentication, from official government
websites at any level: federal, state, county, municipal, township, special
district, tribal and education.

The crawler must never:

- collect anything outside the public professional data boundary (see below);
- attempt to bypass authentication, a CAPTCHA, or any technical restriction;
- retry harder against a source that has refused us;
- follow links onto a domain the run was not scoped to;
- collect in production from a source nobody has reviewed and approved.

A source that blocks us is recorded as blocked and left alone. That is the whole
response. `HttpFetcher` treats 401, 403 and 429 as non-retryable refusals, and
`CrawlEngine` stops the target and records `blocked_by_source` the moment a page
contains a human-verification challenge.

## The source policy gate

Evaluated before robots.txt and before the first fetch, so an unapproved source
is never requested at all.

`prohibited` is absolute and no approval overrides it. `review_required` and
`unknown` block until a person records an approval on the policy row. A source
with no policy row blocks unless the deployment has explicitly opted into
collecting from unreviewed sources. A refusal raises `SourcePolicyViolation` and
records the target as `policy_hold`.

The approved-batch worker loads `source_policies` rows before claiming work. The
operator console records the review evidence and a separate production
approval. Discovery and collection both evaluate that registry before robots
and before a source request. A target without an applicable approval moves to
`policy_hold`.

A vendor's assurance that data is compliant is not a review, is not an approval,
and never overrides the suppression list. See `SOURCE_POLICY_REVIEW.md`.

Fixture runs are ungated, because nothing is collected from anywhere.

## The public professional data boundary

`applyDataBoundary` runs on every extracted record before anything is stored. It
drops the field, counts the drop, and records the reason without ever recording
the offending value.

**Allowed** when the source policy permits: name, published title, department,
organization, professional office address, public work phone, public work email.

**Never collected or inferred**, whatever a page displays:

| Kind                   | Caught by                                        |
| ---------------------- | ------------------------------------------------ |
| `government_id_number` | Social Security number patterns                  |
| `date_of_birth`        | Birth-date labels, and date values beside them   |
| `financial_account`    | Card patterns, routing and account number labels |
| `medical`              | Diagnosis, health condition, patient identifier  |
| `home_address`         | Home, residential and personal address labels    |
| `family_information`   | Spouse, children, dependents, emergency contact  |
| `personal_email`       | Free consumer email providers                    |
| `credential`           | Password, API key, secret, token, PIN            |

Student information is out of scope entirely and is not a category the crawler
tries to detect and drop: education directories are staff directories, and any
page presenting student data is the wrong page.

Personal email addresses are dropped rather than stored. A public employee's
personal mailbox is out of scope even when a directory publishes it. If a
specific lawful use for them is ever approved, that approval changes this
document first.

## Identification

Every request carries a `User-Agent` that names the crawler and links to a page
explaining what it does and how to ask to be removed. It comes from
`DEFAULT_CRAWL_POLICY`, whose default points at `example.invalid` precisely so
an unconfigured deployment is obvious rather than anonymous.

`CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_URL` are required by the approved-batch
worker. It refuses to start without both, and the values reach ordinary requests
and robots.txt requests.

## robots.txt

`HttpRobotsProvider` fetches and caches robots.txt per origin and parses
User-agent grouping, Allow, Disallow (with `*` and `$`) and Crawl-delay, with
longest-match precedence. A disallowed path is not fetched: the engine records a
`robots_disallowed` error, notes `blocked_by_robots` and stops that target. An
unreachable robots.txt is permissive only for compatibility with non-production
callers. The production batch worker selects fail-closed behavior, records the
block and does not fetch the target.

A `Crawl-delay` longer than our configured delay wins.

## Limits

Defaults in `DEFAULT_CRAWL_POLICY`, all overridable per jurisdiction:

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

The Texas education configuration overrides `requestDelayMs` to 2000 and
`maxPagesPerDomain` to 150: many organizations touched lightly, rather than one
touched heavily. A jurisdiction with a handful of large sites would tune it the
other way.

## Guards

`CrawlGuards` enforces, and every stop is recorded on the run:

- `blocked_by_source_policy` before any request, when the gate refuses
- `page_budget_exhausted`, `domain_budget_exhausted`, `depth_limit`
- `pagination_loop` for a sequential pager that revisits a page already
  followed, including a cycle back to the seed
- `duplicate_content` when a body hashes identically to one already fetched
- `no_progress` after N consecutive pages producing no new people
- `empty_success` when a page parses cleanly and holds nobody, which
  distinguishes an empty directory from a broken adapter
- `repeated_failures`, `blocked_by_robots`, `blocked_by_source`
- `excluded_by_policy` for a URL an exclusion pattern caught

Numbered pagers and filter lists legitimately link backwards, so a repeat there
is a duplicate to skip, not a loop. Only sequential pagination (next link,
cursor, load-more, infinite scroll, offset, page parameter) treats a revisit as
a cycle.

`no_progress` counts distinct people, not distinct rows: the engine keys it on a
record identity fingerprint rather than a page-scoped record key, so a pager
that re-serves the same fifty people on every page stops rather than running to
the page budget.

## Exclusions

`DEFAULT_URL_EXCLUSION_PATTERNS` keeps the crawler out of calendars, news and
press archives, athletics schedules, tag and category pages, login and portal
paths, menus, galleries, stores, binary files and anything with a date
parameter. Calendars matter most: they generate an effectively unbounded
paginated URL space and are the classic way a directory crawl becomes an
unbounded one.

Jurisdictions add their own via `extraUrlExclusions`, and `domainDenyList`
records domains never to crawl, each with a reason.

## Cross-domain

A run may only fetch the seed's registrable domain unless `allowedDomains` says
otherwise.

United States locality domains need care, because they come in two shapes:

```
sample.k12.tx.us    a label directly before the state
ci.austin.tx.us     a label before a place name
```

Getting this wrong collapses every public body in a state onto one apparent
site, which would let a run scoped to one city wander into a county's pages.
`registrableDomain` takes the label table from the taxonomy and resolves both
shapes, so `co.harris.tx.us` and `ci.austin.tx.us` are correctly different
sites, and `staff.sample.k12.tx.us` and `sample.k12.tx.us` are correctly the
same one.

The table is data, not a rule: `registrableDomain` with no labels supplied
behaves like an ordinary two-label resolver.

## Storage of raw responses

Every successful production source response is gzip-compressed and written to
private S3-compatible object storage before parsing. The key is content
addressed by the source URL hash and exact response-body hash. If the archive
write fails, the fetch does not succeed and no record from that response can be
ingested. Every fetched response receives a `source_document_versions` row,
including an empty page or a challenge page, with its storage key, source policy,
HTTP status, content type and actual robots decision.

Fixture fetchers use non-network fixture keys and never contact object storage.
The archive is evidence and may contain page material that the normalized data
boundary rejects, so the bucket must remain private with worker-only access.

## Running a real crawl

Not done during repository construction, and not done from a developer machine
without a decision to do it. `pnpm crawl:fixture` runs the entire pipeline
against saved fixtures with no network access. Before any live run:

1. Confirm the jurisdiction's official sources are marked verified.
2. Confirm every domain in scope has a reviewed source policy with a recorded
   production approval, and none is prohibited (`pnpm admin policies`).
3. Set a real `CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_URL` with a reachable
   policy page.
4. Configure the five `STORAGE_*` values for a private S3-compatible bucket and
   verify the worker can write and recover an archived response.
5. Start with a small approved sample of targets, not a jurisdiction.
6. Read the failure breakdown (`pnpm admin failures`) before widening.
