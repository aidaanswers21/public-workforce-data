# National organization spine

The national spine is built from official bulk files before any employee
directory is crawled. This is deterministic data engineering, not an AI task.

## Layers

The organizer writes separate newline-delimited JSON files so a large release
can be streamed, inspected, counted and imported in bounded transactions:

| File                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `geographic-areas.ndjson`                  | States, territories, counties, county subdivisions, places and school district areas |
| `organization-source-records.ndjson`       | One normalized record for each organization row published by Census, NCES or USA.gov |
| `organization-overlays.ndjson`             | Fresher state records that can enrich a canonical row by an exact shared identifier  |
| `organization-relationships.ndjson`        | Published parent and child links, always by identifiers                              |
| `exact-identifier-website-overlays.ndjson` | Website values an overlay can attach without a name match                            |
| `website-resolution-queue.ndjson`          | Organizations still missing a website after exact overlays                           |
| `reconciliation-required.ndjson`           | Useful source rows that cannot be merged without a reviewed crosswalk                |
| `classification-work.ndjson`               | Controlled mappings, authoritative crosswalks and parent-level inheritance still due |
| `summary.json`                             | Counts, website coverage and unresolved work by source                               |

The generated files are operational staging data under `.context/` and are not
committed. Source files are also not committed. The code, mappings, tests and
documentation are the reproducible asset.

The organizer rejects an AskTED row that cannot produce both its district and
campus record, rejects duplicate campus identifiers and refuses inconsistent
values repeated for one district. Its summary separates district and campus
counts, website counts, represented counties and Census counties absent from
the source. The importer compares every source count and website count to the
checked inventory before it can connect to a database.

USA.gov A-Z aliases use the stable official node ID plus the published normalized
name as the source-record key. This preserves each published alias without changing
the official agency identifier.

Run the local organizer after placing the verified downloads under
`.context/national-spine/`:

```bash
pnpm spine:organize
```

This command reads local files only. It does not contact a source and it does
not write to a database.

## Operator console

The authenticated console exposes an **Organization spine** page. It keeps two
sets of counts visibly separate:

- The checked organizer manifest reports the locally preserved artifacts by
  source, geography, website coverage and unresolved work.
- The hosted database summary reports only source rows and canonical
  organizations that have actually been loaded into the database used by that
  console.

The missing-website queue can be filtered by government level, sector, state
and organization type. The same state list is available to national collection
project configurations, so a national bulk source can be narrowed to one state
without pretending it is a different source.

The **Explore organizations** page reads the provenance-bearing source records
directly, including records that are correctly held from canonical import. Its
views are supplied by sector packs. The education pack contributes school and
district views with enrollment, teacher FTE, total staff FTE, grade span and
school year columns. Each view names its primary official release, so state
overlay rows remain available for exact-ID enrichment without appearing as
duplicate organizations in the explorer. Each row opens a profile with its
location, website, identifiers, complete published attributes and immutable
source version.

An operator may select up to 250 visible records at once and add them to a
collection project. Migration `0018_collection_project_source_records.sql`
stores that selection separately from canonical project organizations. If a
selected source record already has a canonical organization ID, it is also
added to the project's crawl-ready organization scope. If it is still on a
classification hold, the project reports it as held. Selection never creates a
target, approves a batch or contacts a website.

## Durable import

Migration `0017_organization_spine_staging.sql` adds a default-deny staging
table. Migration `0019_spine_materialization.sql` adds jurisdiction linkage,
the raw published website value and state-scoped identifier uniqueness. Each
row references both a source document and its immutable version. Incomplete
classifications and reconciliation work do not silently become canonical
organizations. A fully classified state record may canonicalize or enrich an
existing organization only when one of its identifiers matches exactly.

Preview an import without connecting to a database:

```bash
pnpm spine:import
```

After the target database has migrations 0016 and 0017, a specifically
approved import uses explicit flags and an explicit connection string:

```bash
DATABASE_URL=... pnpm spine:import -- --apply --canonicalize
```

The importer streams batches of 2,000 staged rows and canonicalizes at most
5,000 ready rows per transaction. It resolves all published identifiers, not
only the first one, and fails when exact identifiers point at conflicting
organizations or classifications. After canonicalization it materializes
published parent relationships and Texas education attributes. The AskTED
month-only enrollment date remains a source attribute rather than being given
an invented day in the date-valued extension column. Blank charter values and
the distinct `Hybrid` status likewise remain null instead of becoming false or
true guesses.

`--apply` is never inferred. Omitting `--canonicalize` loads the reviewable
staging rows without creating canonical organizations. Every catalog URL must
also resolve to a source-policy row that permits collection or carries a
recorded production approval. Missing, prohibited and unapproved policy
decisions stop the import.

## Merge rule

Automatic merging requires an exact identifier in the same identifier system.
For example, a state education overlay may attach a website to an NCES row when
both publish the same NCES identifier. A similar name, city or domain is not an
automatic merge.

Rows without a shared identifier stay separate in `reconciliation-required` or
retain a classification review reason. This is intentional. A visible crosswalk
gap is safer than merging two public bodies that happen to have similar names.

## Organization-level aggregates

NCES organization-level enrollment, total staff FTE and teacher FTE are joined
to the directory source records by exact NCES identifier. The published data
state is preserved beside each value. Missing, suppressed and not-reported
values remain null. These are aggregate organization facts, not student or
employee records.

## Database load order

1. Record each source document and immutable source version.
2. Load every organization source row into provenance-bearing staging.
3. Canonicalize only organization records with a complete classification and
   an official identifier.
4. Load exact external identifiers and source observations.
5. Load parent organizations before children and add effective-dated
   relationships.
6. Apply exact-identifier overlays.
7. Keep incomplete classifications and non-exact crosswalks in review.
8. Populate the missing-website queue from canonical organizations.

For the current AskTED artifact, the reconciliation baseline is 1,216 distinct
districts, 9,682 campuses, 1,213 district websites and 7,476 campus websites.
The file represents 253 counties. Loving County is absent from the published
rows, so the importer records that coverage difference rather than inventing an
organization to force a count of 254.

A production load is a database migration/import operation and requires a new,
specific owner approval. Organizing the local files is not that approval.
