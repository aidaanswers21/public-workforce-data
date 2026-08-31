# Education in the platform

Education was the first vertical this platform served, and for a while it was
the only one. That history is why this document exists: to say exactly where
education knowledge lives now, and to make it obvious when it has leaked back
into somewhere neutral.

## Education is a sector, not the shape

The neutral core knows about organizations, relationships, jurisdictions,
geographic areas, people, employment assignments, contact points, evidence and
suppression. It does not know what a school is, what a district is, what a grade
level is, or that any of those exist.

A school district is an organization with `sector_code = 'education'` and
`organization_type_code = 'school_district'`. Its government level is whatever
it factually is: `special_district` for an independent district, `municipal` or
`county` for one run by a general-purpose government, `state` for a state
education agency. A school beneath it is another organization joined by a
`part_of` relationship. Neither is a special case anywhere in the core.

**There is no `education` government level.** Government level and sector are
orthogonal: what kind of government a body is part of, and what kind of work it
does. An `education` level would force every education organization to share a
level it does not have, and would put a sector into a list that is not about
sectors. `packages/database/src/repositories/repositories.test.ts` stores the
same `school_district` type at three different levels to prove the point.

## Where education knowledge lives

| Knowledge                                                                                                      | Location                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Organization types, identifier systems, role categories, title rules, specialty patterns, directory vocabulary | `packages/sectors/education/src/pack.ts`                                               |
| Grade spans, campus type, charter and magnet flags, enrolment                                                  | `packages/sectors/education/src/attributes.ts` and `education_organization_attributes` |
| District and school name normalization                                                                         | `packages/sectors/education/src/naming.ts`                                             |
| Texas education sources, column mappings, seeds                                                                | `packages/jurisdiction-config/texas-education/`                                        |
| Saved education directory pages                                                                                | `tests/fixtures/`                                                                      |

Nothing else. `tests/neutral-core-guard.test.ts` reads every neutral source file
and fails on `school`, `teacher`, `faculty`, `campus`, `student`, `classroom`,
`pupil`, `curriculum`, `isd`, `nces`, `k12`, `kindergarten`, `principal` and
`superintendent` in executable code.

Two files are exempt by path, each with its own argument:

- `packages/taxonomy/src/reference/domains.ts`, where `k12` sits beside `co`,
  `ci` and `lib` as a table of `.us` DNS labels. A guard test asserts that file
  contains no imports, no functions and no branching.
- `packages/core/src/policy/data-boundary.ts`, which names `student` and `pupil`
  in order to **refuse** them. That is the opposite of vertical logic: moving
  the patterns into the education pack would mean student protection applied
  only where an education pack happened to be registered, and a county library
  publishing a minor's details is exactly the case nobody would have registered
  it for. A guard test strips the prohibition patterns and asserts no education
  term remains anywhere else in the file.

The word `district` is deliberately absent from that list. Special districts and
congressional districts are general-government concepts, so only the education
sense is banned, through the phrase "school district".

## The extension table

`education_organization_attributes` is keyed to `organizations.id` and holds
grade span, school type, operational status, charter, magnet and virtual flags,
enrolment with the year it applies to, and Title I status. Grades are stored as
published (`PK`, `KG`, `K`, `01`), not normalized into numbers, because sources
disagree and normalizing loses the disagreement.

A trigger, `education_attributes_sector_guard`, rejects any row whose
organization is not in the education sector. That is not decoration: without it,
the first person to attach a grade range to a county government would make the
neutral table quietly education-shaped again.

The pattern generalizes. A sector that needs attributes the core should not
carry gets its own table with its own guard, and no nullable columns are added to
`organizations`.

## What was removed from the core

The generalization moved twelve concrete pieces of education knowledge out of
neutral packages. They are listed here so the shape of the leak is recognizable
next time:

- A `principal` prefix in the name parser.
- A kindergarten grade pattern in the title normalizer, now an injected
  specialty pattern.
- `k12` in the domain resolver, now a row in the locality label table.
- `school` and `campus` in the HTML extraction heuristics, now
  `organizationFieldAliases` in the vocabulary.
- Education field aliases in `generic-json` and education pagination filters in
  `generic-html`, both now vocabulary.
- `superintendent` and `principal` in the base title rules, now in the education
  pack, and scoped so they only reach education-sector records.
- The `education` government level itself, which is now a sector alone.

Each was small, reasonable in context, and would have made the platform
education-shaped forever.

## Texas is a jurisdiction, not a state config

`@public-workforce/jurisdiction-texas-education` has the key `texas-education`,
the sector `education`, and the government level `special_district`. Texas
independent school districts are political subdivisions with their own boards
and taxing authority, which makes them special districts; the sector is what
they do and the level is what they are. It is a configuration for education in
one state, not a configuration for Texas.

Texas state agencies, Texas counties and Texas cities would be separate
jurisdiction configurations at their own government levels, sharing the same
geographic areas and none of the same organization types. That separation is
what makes "onboard Texas counties" a configuration task rather than a rework.

## When you are about to add education knowledge

Ask which of these it is:

- **Vocabulary** a page uses: it goes in the pack's `vocabulary`.
- **A kind of organization**: it goes in the pack's `organizationTypes`.
- **A job title or role**: it goes in the pack's `titleRules` and
  `roleCategories`.
- **An attribute only schools have**: it goes in the extension table.
- **A source for one state**: it goes in a jurisdiction configuration.

- **A prohibition**: it goes in the data boundary, because refusing a thing
  requires naming it and the refusal must not depend on a pack being registered.

If it fits none of those and seems to belong in `packages/core`, that is the
signal to stop and work out what the neutral version of the idea is.
