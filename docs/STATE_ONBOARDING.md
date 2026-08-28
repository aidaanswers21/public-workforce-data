# State onboarding

Adding a state is configuration plus verification. It is not a code change to
the crawler, the adapters, the schema or the pipeline. If onboarding a state
requires touching any of those, that is a bug in the seam, not a step in this
process.

## The process

### 1. Create the state configuration package

`packages/state-config/<state>/` exporting a `StateConfig`. Copy
`packages/state-config/texas/` as the shape. Add it to the root
`tsconfig.json`, the `vitest.config.ts` aliases, and
`services/crawler-worker/src/registries.ts`.

### 2. Define the official sources

For each authoritative list, record its name, URL, format, what it provides,
`verified: false`, and a `verificationNote` saying exactly what a human must
check. Nothing is guessed. `assertSourceVerified` refuses to import from an
unverified source, so this is enforced rather than advisory.

### 3. Verify each source, by hand, once

Open the URL. Confirm it resolves and is the current file. Download it. Confirm
the column names in `columnMappings` match the real header row. Only then set
`verified: true`. This is the step that stops the platform inventing a schema
for a government file nobody has read.

### 4. Map the official identifiers

Populate `identifierMappings` with the state's own identifier, what the state
calls it, and a pattern. Texas uses a six digit County-District Number; other
states differ. Use official identifiers as the upsert key wherever they exist,
because names change and identifiers do not.

### 5. Establish county normalization

Populate `countyAliases` with the spellings that vary between published files,
and set `expectedCountyCount`. After the first import, compare the distinct
county count against it. A mismatch means aliases are missing, and it is the
check that catches the ones nobody predicted.

### 6. Import districts and schools

Run the importer against a verified source. `DelimitedInstitutionImporter`
handles CSV and TSV including quoted fields with embedded commas and newlines.
Every unmappable row is reported in `rejected` with a reason: an import is
never silently lossy.

Seed rows in `seedInstitutions` are for local development only. They carry
`identifiersPending: true` and no website, because inventing either would put
unverified values in the database with no source page behind them.

### 7. Discover directories

Run the discovery worker over district and school websites. It records
`crawl_targets`, or marks the site `unsupported_platform` when no adapter claims
it. Keeping discovery separate from crawling is what makes "we could not find a
directory" and "we found one and it broke" different, countable outcomes.

### 8. Reuse adapters; write one only when genuinely needed

Check the unsupported-platform count first. Write a new adapter only when a real
platform appears repeatedly and `generic-html` handles it badly. One district
with unusual markup is not a platform.

### 9. Set crawl tuning

`crawlPolicy` overrides only what the state needs. `extraUrlExclusions` adds
state-specific paths that are never directories. `domainDenyList` records
domains never to crawl, each with a reason.

### 10. Add QA fixtures and report coverage

Save at least one fixture per directory platform found in the state, with
expected output. Then run `pnpm admin coverage <STATE>` and read it honestly.

## Definition of done

A state is onboarded when all of these hold:

- [ ] The config package exists, is registered, and `validateStateConfig`
      returns no errors.
- [ ] Every official source is `verified: true`, with the URL and column mapping
      confirmed against the real file by a person.
- [ ] Identifier mappings are populated and used as the import upsert key.
- [ ] The importer has run; district and school counts are within a stated
      tolerance of the official published totals, and that tolerance is written
      down.
- [ ] The distinct county count matches `expectedCountyCount`, or every
      difference is explained.
- [ ] No seed row with `identifiersPending: true` remains in the imported set.
- [ ] Directory discovery has run over every district; the discovered,
      unsupported and failed counts are recorded.
- [ ] Every directory platform in the state has an adapter and at least one
      fixture with expected output.
- [ ] A fixture-based crawl passes for each platform, and repeating it creates
      no duplicate records.
- [ ] Coverage is reported as a measurement, with the denominator stated.
- [ ] Crawl policy overrides are set and reviewed.
- [ ] Suppression entries for any districts that have asked not to be contacted
      are loaded before any export.

## Never claim coverage you have not measured

"Complete coverage" means a measured number against a stated denominator, for
example "1,187 of 1,207 districts in the TEA district file have a discovered
directory; 20 are recorded as unsupported or failed". It never means "we crawled
the state".

## Do not research states that have not been approved

Only the approved state is researched and configured. Texas is the first. The
next state starts when someone says so.
