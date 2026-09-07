# Organization website resolution

Website resolution and employee-directory discovery are different jobs.
Website resolution answers which public website belongs to an organization.
Directory discovery starts only after that website is canonical.

## Bulk-first resolution order

For every active organization whose `website_url` is null:

1. Apply a website published in another approved official dataset when an exact
   organization identifier matches.
2. Match against an approved official domain registry using identifiers first,
   then exact name, state and address evidence.
3. Match against an approved official organization directory.
4. Search only the unresolved remainder in bounded batches.
5. Record search results as candidates and require review. A high score is not
   proof that a website is official.

The first stage is cheap database work. The second and third stages are bulk
joins. Only the final remainder needs search requests. AI is not required for
the normal path.

## Durable database workflow

`WebsiteResolutionRepository.missingWebsiteQueue` pages through the missing set
with filters for government level, sector, state and organization type. It uses
keyset pagination and supports batches up to 5,000 organizations.

`organization_website_candidates` stores:

- the organization and canonical candidate URL;
- the evidence category and match signals;
- confidence;
- the exact source document and immutable source version;
- proposed, verified, rejected or superseded review state;
- the named reviewer, review time and note.

Recording a candidate never changes `organizations.website_url`. Verification
is the separate action that promotes it. Promotion refuses to overwrite a
website already present on the canonical organization row and appends an audit
event.

## Volume and safety

Website resolution should process thousands of organizations per database
batch, but real requests remain subject to source policy, rate limits and the
approval requirements in `AGENTS.md`. A search provider, official registry or
website is a real source. Preparing the queue does not authorize contacting it.

Do not rotate IP addresses, bypass blocks, solve CAPTCHAs or retry through a 403. Record the source as blocked. A hosted worker can provide stable operations
and a stable egress address, but it is not an evasion mechanism.

Once a website is verified, ordinary directory discovery can create governed
`crawl_targets` from it. See `CRAWLING_POLICY.md`.
