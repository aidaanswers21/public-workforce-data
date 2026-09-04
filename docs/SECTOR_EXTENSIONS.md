# Sector extensions

A sector pack is how a vertical teaches the platform its vocabulary without the
platform learning anything about that vertical.

## What a pack contributes

`SectorPack` in `@public-workforce/taxonomy`:

```ts
interface SectorPack {
  key: string;
  displayName: string;
  description: string;
  /** Which organizations this pack's rules and vocabulary may classify. */
  appliesTo: SectorScope;
  /** Reference codes this pack intentionally replaces. */
  overrides?: readonly string[];
  organizationTypes?: readonly OrganizationTypeRow[];
  identifierSystems?: readonly IdentifierSystemRow[];
  geographicAreaTypes?: readonly ReferenceRow[];
  jobFamilies?: readonly ReferenceRow[];
  roleCategories?: readonly RoleCategoryRow[];
  titleRules?: readonly TitleRule[];
  titleAbbreviations?: readonly TitleAbbreviation[];
  specialtyPatterns?: readonly RegExp[];
  vocabulary?: Partial<DirectoryVocabulary>;
}
```

`appliesTo` is required; everything after it is optional. A pack that only adds
four title rules is a valid pack, as long as it says who those rules are for.

## Scope: whose records a pack may read

```ts
interface SectorScope {
  sectorCodes: readonly string[] | null; // null = any sector
  governmentLevelCodes: readonly string[] | null; // null = any level
}
```

Both dimensions must match. A null list is a wildcard for that dimension, and an
organization that states neither sector nor level matches only wildcards,
because guessing the missing half is how a rule ends up applied to a record
nobody classified.

| Pack                                   | Scope                                                |
| -------------------------------------- | ---------------------------------------------------- |
| `@public-workforce/sector-education`   | Sector `education`, any level                        |
| `@public-workforce/sector-state-local` | Every sector except education, at sub-federal levels |
| `@public-workforce/sector-federal`     | Any sector, at the `federal` level                   |

Education is scoped by sector and not by level, because that is what education
is once `education` stops being a government level: an independent district is a
special district, a dependent one is part of a city, and both do the same work.
State and local names its sectors explicitly and leaves education out, so a
county rule cannot reach a school employee at the same level. Federal is scoped
by level, because "federal" is a level: a federal laboratory does
environment-sector work and a federal bureau does general-government work, and
both use the same grades and abbreviations.

### Precedence

Deterministic, and in this order:

1. Sector packs whose scope matches the organization, in registration order.
2. The neutral base, which always applies.

First match wins. An out-of-scope pack is not consulted at all, which is what
stops an education rule classifying a federal contracting officer and a federal
abbreviation expanding inside a school district. `Taxonomy.forScope()` builds
the rule set for one organization and records which packs contributed, and
`buildScopedRules()` in the crawler worker pairs it with the matching
vocabulary so the two cannot drift apart.

`tests/title-taxonomy.test.ts` asserts the seam on nine titles that one vertical
owns and another uses differently: Veterans Counselor, Fitness Instructor,
Principal Architect, Principal Scientist, Executive Assistant, Deputy Chief,
School Counselor, Teacher and Contracting Officer.

## How composition works

`new Taxonomy(packs)` merges the neutral base with every registered pack, then
calls `assertCoherent()`, which throws if a pack names a government level, a
sector, a job family or a role category that does not exist, or scopes itself to
one. A typo in a pack fails at start-up rather than becoming a row nothing can
join to.

### Collisions are errors, not last-writer-wins

Two packs defining the same code, or a pack redefining a base code, used to
resolve by registration order: last writer won, invisibly, and which pack that
was depended on an argument list in another file. It is now a
`ReferenceCollisionError` at construction, reporting every collision at once.

A pack that genuinely means to replace a code lists it in `overrides`, which
makes the intent reviewable in the diff. A pack may not contribute government
levels, sectors, relationship types, extraction methods or obfuscation kinds at
all: those are the axes every other code is described against, and only the
neutral base defines them.

Shipped today:

| Pack                                   | Organization types                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@public-workforce/sector-education`   | `school_district`, `school`, `charter_organization`, `education_service_agency`, `state_education_agency` |
| `@public-workforce/sector-state-local` | `state_board_commission`, `county_elected_office`, `municipal_utility`, `court`                           |
| `@public-workforce/sector-federal`     | `federal_independent_agency`, `federal_regional_office`, `federal_laboratory`                             |

The neutral base carries 18 organization types, 40 role categories, 18 job
families and 50 title rules. Composing all three shipped packs produces 30
organization types, 66 role categories, 88 title rules, 15 identifier systems
and 8 specialty patterns.

## No migration, ever

Organization types, role categories, job families and identifier systems are
controlled reference rows with stable `code` primary keys, not Postgres enum
values. `seedReferenceData(client, taxonomy)` writes whatever the composed
taxonomy holds.

Adding a sector therefore touches no migration. If you find yourself writing one
to add an organization type, the type is in the wrong place.

## Directory vocabulary

`DirectoryVocabulary` is how a pack teaches the neutral extraction code what a
vertical's pages look like, without the code naming the vertical:

| Field                      | Used for                                                |
| -------------------------- | ------------------------------------------------------- |
| `headingTerms`             | Recognizing a directory heading                         |
| `urlHints`                 | Scoring a URL as a likely directory                     |
| `sharedInboxLocalParts`    | Classifying `info@`, `admissions@` and friends          |
| `sharedInboxPrefixes`      | The same, by prefix                                     |
| `organizationLabelWords`   | Telling "Front Office" from a person's name             |
| `titleIndicatorTerms`      | Deciding whether a cell holds a title                   |
| `organizationFieldAliases` | Mapping a JSON or table field onto an organization name |
| `organizationNameSuffixes` | Normalizing an organization name                        |

`composeVocabulary` merges the base with every pack's contribution. This is what
lets `generic-html` handle a school staff table and a federal field-office
listing with the same code and no branch.

## Adding a pack

1. Create `packages/sectors/<sector>/` with a `package.json` and a
   `tsconfig.json` referencing `shared-types` and `taxonomy`. Add it to the root
   `tsconfig.json`, `tsconfig.eslint.json` paths, `tsconfig.tests.json` inherits
   them, and the `vitest.config.ts` aliases.
2. Export a `SectorPack`. Declare `appliesTo` explicitly, even if both
   dimensions are null. Codes are stable identifiers: choose them once, because
   they become primary keys, and a code another pack already defines is an error
   unless you list it in `overrides`.
3. Register it in `buildTaxonomy()` in
   `services/crawler-worker/src/registries.ts`.
4. If the sector needs attributes the neutral organization core should not
   carry, add a table for them with a trigger guarding it to the sector. See
   `EDUCATION_IN_THE_PLATFORM.md`.
5. Add a fixture and a test. `tests/title-taxonomy.test.ts` is where composed
   title behaviour is asserted, and it is where an over-broad rule gets caught.

## Watch for over-broad title rules

A pack's title rules join one flat, ordered rule table. A rule that is too
general will shadow a more specific rule from another pack.

Two real examples caught by `tests/title-taxonomy.test.ts`:

- A federal rule matching `\b(administrator|commissioner|director-general)\b`
  swallowed "Zoning Administrator" and "Elections Administrator", which are local
  government roles. It is now anchored, plus the deputy, acting and
  "administrator of the" forms.
- An education rule matching `\blibrarian\b` swallowed the base
  `library_services` category, which covers public librarians. It is now narrowed
  to the school-library forms.

The test composes every pack and asserts specific titles resolve to specific
categories, which is the only reliable way to notice this.
