# Sector extensions

A sector pack is how a vertical teaches the platform its vocabulary without the
platform learning anything about that vertical.

## What a pack contributes

`SectorPack` in `@pan/taxonomy`:

```ts
interface SectorPack {
  key: string;
  displayName: string;
  description: string;
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

Every field is optional. A pack that only adds four title rules is a valid pack.

## How composition works

`new Taxonomy(packs)` merges the neutral base with every registered pack, then
calls `assertCoherent()`, which throws if a pack names a government level, a
sector, a job family or a role category that does not exist. A typo in a pack
fails at start-up rather than becoming a row nothing can join to.

Shipped today:

| Pack                      | Organization types                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@pan/sector-education`   | `school_district`, `school`, `charter_organization`, `education_service_agency`, `state_education_agency` |
| `@pan/sector-state-local` | `state_board_commission`, `county_elected_office`, `municipal_utility`, `court`                           |
| `@pan/sector-federal`     | `federal_independent_agency`, `federal_regional_office`, `federal_laboratory`                             |

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
2. Export a `SectorPack`. Codes are stable identifiers: choose them once,
   because they become primary keys.
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
