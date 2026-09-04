# Onboarding a federal agency

A federal jurisdiction is not a state, and most of what makes state and local
onboarding work does not apply to it. This document covers the differences.
Read `ONBOARDING_STATE_LOCAL.md` for the steps the two share.

## The rule that shapes everything else

**A federal organization or employee must never require a state as its
organizational parent.**

A federal employee working in Austin has a duty location in Texas. Texas governs
nothing about their employment. Any model that makes the state their parent has
turned a federal worker into a state worker, and every downstream query, export
and suppression scope inherits the error.

The platform enforces this in three places:

- `organizations` has no parent column at all, so nothing can be silently
  defaulted. Ancestry is `organization_relationships` rows.
- `jurisdiction.stateCode` is nullable and is null for a federal jurisdiction.
- `validateJurisdictionConfig` reports an error when a configuration with
  `governmentLevelCode: 'federal'` names a state as an organizational parent.

`tests/extensibility.test.ts` construction 9 builds a federal worker with a duty
location in a state, asserts no state appears anywhere in their organizational
ancestry, and asserts the export still carries their duty location correctly.

## Configuration differences

| Field                         | State or local                      | Federal                                       |
| ----------------------------- | ----------------------------------- | --------------------------------------------- |
| `governmentLevelCode`         | `state`, `county`, `municipal`, ... | `federal`                                     |
| `jurisdiction.stateCode`      | The postal code                     | `null`                                        |
| `jurisdiction.areaFipsCode`   | The area's FIPS code                | Usually `null`                                |
| `expectedAreaCount`           | Counties in the state               | Usually `null`; regions are not a fixed count |
| Parent in `seedOrganizations` | Often the state or county           | Another federal body, or `null`               |

Organization types come from `@public-workforce/sector-federal`:
`federal_independent_agency`, `federal_regional_office`, `federal_laboratory`,
alongside the neutral base types (department, agency, office, board,
commission).

## Identifiers

Federal bodies carry their own identifier systems, not state ones. The federal
pack ships the CGAC agency code. Add others to the pack, not to the jurisdiction
configuration, when they apply across agencies rather than to one.

`external_identifiers` holds one row per system, so an agency can carry a CGAC
code and any other scheme at the same time.

## Regional offices

A regional office is an organization with a `part_of` relationship to its parent
agency and an `organization_locations` row for where it physically is.

Those two facts are independent. The relationship says who employs the staff;
the location says where they sit. A regional office covering four states has one
parent, one location and no state parent.

`tests/extensibility.test.ts` construction 5 builds a federal agency with offices
in several states and asserts that suppressing one office does not touch the
others, and that suppressing the parent agency withholds them all.

## Duty location still matters

Federal employees have duty locations, and the export carries them:
`duty_location_city`, `duty_location_county`, `duty_location_state`. Filling
those in is correct. Deriving the jurisdiction from them is not. See
`JURISDICTION_VS_DUTY_LOCATION.md`.

The `geographic_area` suppression scope works on duty location, so "stop
contacting everyone working in this county, whoever employs them" is expressible
without touching the jurisdiction.

## Source policy is stricter in practice

Federal sites often publish explicit terms on automated access and on commercial
use of published data, and the two answers frequently differ. Record them
separately in `commercial_use_status`, `solicitation_status` and
`automated_access_status` rather than flattening them into one status. See
`SOURCE_POLICY_REVIEW.md`.

Bulk datasets are common at the federal level and are usually the better source:
a published dataset with clear terms beats crawling the same information off
HTML. Record it with `sourceTypeCode: 'bulk_dataset'` and skip the crawl.

## Definition of done

Everything in `ONBOARDING_STATE_LOCAL.md`, plus:

- [ ] `jurisdiction.stateCode` is null.
- [ ] No organization in the imported set has a state in its ancestry.
- [ ] `validateJurisdictionConfig` returns no errors, including the federal
      parent check.
- [ ] Regional offices have both a `part_of` relationship to their agency and an
      `organization_locations` row.
- [ ] Duty locations are populated where the source publishes them, and left
      null where it does not.
- [ ] Where a bulk dataset exists with acceptable terms, it is used instead of
      crawling.
