# Onboarding a state, county, municipal or special-district jurisdiction

Adding a jurisdiction is configuration plus verification. It is not a code
change to the crawler, the adapters, the schema or the pipeline. If onboarding a
jurisdiction requires touching any of those, that is a bug in the seam, not a
step in this process.

For a federal agency, read `ONBOARDING_FEDERAL.md` instead: a federal
organization has no state above it, and several steps here do not apply.

## The unit of onboarding

A jurisdiction plus the sector being worked. Texas education and Texas state
government are two configurations, not one, because they have different official
sources, different organization types, different identifiers and different
directory platforms. They share geographic areas and nothing else.

Pick the level first:

| Level              | Jurisdiction is           | Typical official source                      |
| ------------------ | ------------------------- | -------------------------------------------- |
| `state`            | The state                 | A state agency directory or open data portal |
| `county`           | One county                | The county's own department listing          |
| `municipal`        | One city, town, village   | The city's department and staff listing      |
| `township`         | One township              | The township's listing                       |
| `special_district` | One district or authority | The district's own site or a state registry  |
| `education`        | Education in one state    | The state education agency's file            |

## The process

### 1. Create the jurisdiction configuration package

`packages/jurisdiction-config/<key>/` exporting a `JurisdictionConfig`. Copy
`packages/jurisdiction-config/texas-education/` as the shape. Add it to the root
`tsconfig.json`, the `tsconfig.eslint.json` paths, the `vitest.config.ts`
aliases, and `buildJurisdictionRegistry()` in
`services/crawler-worker/src/registries.ts`.

Set `governmentLevelCode` and `sectorCodes` from the taxonomy. They are separate
questions: the level is what kind of government the bodies are, the sector is
what work they do, and neither is derived from the other. Texas public education
is `special_district` plus `education`.
`validateJurisdictionConfig` reports an error for a code that does not exist, so
a typo fails at configuration time.

### 2. Set the jurisdiction row

`jurisdiction.code`, `jurisdiction.name`, `jurisdiction.stateCode` (the postal
code of the state this sits in) and `jurisdiction.areaFipsCode` when there is
one. FIPS codes matter: they are how a county in this configuration matches the
same county in another.

### 3. Define the official sources

For each authoritative list, record its name, URL, `sourceTypeCode`, format,
what it provides, `verified: false`, and a `verificationNote` saying exactly
what a person must check. Nothing is guessed. `assertSourceVerified` refuses to
import from an unverified source, so this is enforced rather than advisory.

### 4. Verify each source, by hand, once

Open the URL. Confirm it resolves and is the current file. Download it. Confirm
the column names in `columnMappings` match the real header row. Only then set
`verified: true`. This is the step that stops the platform inventing a schema
for a government file nobody has read.

### 5. Record a source policy and get it approved

Every domain the crawler will touch needs a `source_policies` row, reviewed by a
person, and a recorded production approval before a real run. See
`SOURCE_POLICY_REVIEW.md`. The crawler refuses production collection otherwise,
so skipping this does not produce bad data, it produces a `policy_hold`.

### 6. Map the official identifiers

Populate `identifierMappings` with the issuing authority's identifier, what they
call it, and a pattern. Use official identifiers as the upsert key wherever they
exist, because names change and identifiers do not. An organization can carry
several: `external_identifiers` is one row per system, so a state identifier and
a federal one coexist without a column per scheme.

### 7. Establish geographic area normalization

Populate `areaAliases` with the spellings that vary between published files, and
set `expectedAreaCount` when the jurisdiction has a known number of sub-areas
(for a state, its counties). After the first import, compare the distinct count
against it. A mismatch means aliases are missing, and it is the check that
catches the ones nobody predicted.

### 8. Import organizations

Run the importer against a verified source. The source is a **required
argument** to `import()`, and the first thing the importer does is refuse an
unverified one, so an unread government file cannot be imported by forgetting a
line. `DelimitedOrganizationImporter` handles CSV and TSV including quoted
fields with embedded commas and newlines. Every unmappable row is reported in
`rejected` with a reason: an import is never silently lossy.

Supply a stable source identifier or a parent wherever the file offers one.
Without either, an organization resolves on its name plus its domain, and
without a domain it lands in the identity review queue rather than being merged
or duplicated. See the identity tiers in `DATA_MODEL.md`.

Where the file names a parent, the importer records an
`organization_relationships` row rather than a parent column, so a later
reorganization is a new row with a new effective window instead of an overwrite.
See `ORGANIZATION_HIERARCHY.md`.

Seed rows in `seedOrganizations` are for local development only. They carry
`identifiersPending: true` and no website, because inventing either would put
unverified values in the database with no source document behind them.

### 9. Discover directories

Run the discovery worker over the organizations' websites. It records
`crawl_targets`, or marks the site `unsupported_platform` when no adapter claims
it. Keeping discovery separate from crawling is what makes "we could not find a
directory" and "we found one and it broke" different, countable outcomes.

### 10. Check the sector vocabulary before writing an adapter

Local government pages use different words from education pages. Before
assuming an adapter is needed, check whether the sector pack's
`DirectoryVocabulary` is missing the heading terms, URL hints or field aliases
this jurisdiction's sites use. A vocabulary addition is a few lines in the pack;
an adapter is a package. See `SECTOR_EXTENSIONS.md`.

### 11. Reuse adapters; write one only when genuinely needed

Check the unsupported-platform count first. Write a new adapter only when a real
platform appears repeatedly and `generic-html` handles it badly. One city with
unusual markup is not a platform.

### 12. Set crawl tuning

`crawlPolicy` overrides only what the jurisdiction needs.
`extraUrlExclusions` adds paths that are never directories.
`domainDenyList` records domains never to crawl, each with a reason.

### 13. Add QA fixtures and report coverage

Save at least one fixture per directory platform found, with expected output.
Then run `pnpm admin coverage` scoped to the level and sector, and read it
honestly.

## Definition of done

A jurisdiction is onboarded when all of these hold:

- [ ] The configuration package exists, is registered, and
      `validateJurisdictionConfig` returns no errors.
- [ ] The government level and sector codes exist in the taxonomy.
- [ ] Every official source is `verified: true`, with the URL and column mapping
      confirmed against the real file by a person.
- [ ] Every domain in scope has a reviewed `source_policies` row with a recorded
      production approval, and none is `prohibited`.
- [ ] Identifier mappings are populated and used as the import upsert key.
- [ ] The importer has run; organization counts are within a stated tolerance of
      the official published totals, and that tolerance is written down.
- [ ] Parent relationships are recorded as `organization_relationships` rows
      with effective dates.
- [ ] The distinct area count matches `expectedAreaCount`, or every difference
      is explained.
- [ ] No seed row with `identifiersPending: true` remains in the imported set.
- [ ] Directory discovery has run over every organization; the discovered,
      unsupported and failed counts are recorded.
- [ ] Every directory platform found has an adapter and at least one fixture
      with expected output.
- [ ] A fixture-based crawl passes for each platform, and repeating it creates
      no duplicate records.
- [ ] Coverage is reported as a measurement, with the denominator stated.
- [ ] Crawl policy overrides are set and reviewed.
- [ ] Suppression entries for any organization that has asked not to be
      contacted are loaded before any export.

## Never claim coverage you have not measured

"Complete coverage" means a measured number against a stated denominator, for
example "1,187 of 1,207 organizations in the source file have a discovered
directory; 20 are recorded as unsupported or failed". It never means "we crawled
the state".

## Do not research jurisdictions that have not been approved

Only the approved jurisdiction is researched and configured. Texas education is
the first. The next one starts when someone says so.
