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

Run the local organizer after placing the verified downloads under
`.context/national-spine/`:

```bash
pnpm spine:organize
```

This command reads local files only. It does not contact a source and it does
not write to a database.

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
2. Load geographic areas and their identifiers.
3. Load organization records with a complete classification.
4. Load exact external identifiers and source observations.
5. Load parent organizations before children and add effective-dated
   relationships.
6. Apply exact-identifier overlays.
7. Keep incomplete classifications and non-exact crosswalks in review.
8. Populate the missing-website queue from canonical organizations.

A production load is a database migration/import operation and requires a new,
specific owner approval. Organizing the local files is not that approval.
