# Jurisdiction and duty location

Two facts that look like one and are not.

**Jurisdiction** is who governs an organization. It is an authority
relationship: a state department belongs to a state, a county office belongs to
a county, a federal agency belongs to the federal government.

**Duty location** is where a person actually works. It is a place: a city, a
county, a state, a building.

Collapsing them into one "state" column is the most common modelling mistake in
public-sector data, and it produces wrong answers immediately.

## Where they disagree

- A federal employee works in Austin, Texas. Their duty location is in Texas.
  Their employer's jurisdiction is the federal government, and Texas has no
  authority over them. A model that reads their state as their jurisdiction has
  made them a state employee.
- A state agency's regional office sits inside a county. The county governs
  nothing about it.
- A regional water authority spans four counties. Its jurisdiction is its own
  service area; its staff work in one building in one of those counties.
- A district office and the district headquarters are in different cities. The
  employees have different duty locations and the same jurisdiction.

## How the model keeps them apart

`jurisdictions` carries a code, a name, a government level and an optional
geographic area. `organizations.jurisdiction_id` points at it, and it may be
null while a jurisdiction is not yet known.

`geographic_areas` carries a code, a name, an area type (`state`, `county`,
`municipality`, `region`, and so on), an optional parent area and an optional
FIPS code. `organization_locations` and a person's duty location point at these.

Nothing forces the two to agree, and nothing derives one from the other.

## In the export

The export carries both, in separate columns:

- `jurisdiction`, `government_level` and `sector` describe who governs and what
  kind of work the organization does.
- `duty_location_city`, `duty_location_county` and `duty_location_state`
  describe where the person works.

For a federal employee in Austin, the jurisdiction column says the federal
government and the duty location columns say Austin, Travis County, Texas. Both
are true, and neither is derived from the other.

## Suppression sees both

Two of the eleven suppression scopes work on these separately:

- `jurisdiction` withholds everyone governed by one jurisdiction.
- `geographic_area` withholds everyone whose duty location falls inside one
  area.

A request to stop contacting a state's employees is a jurisdiction suppression.
A request to stop contacting everyone working in one county, whoever employs
them, is a geographic-area suppression. They are different asks and they get
different rows.

## Practical rule

When you are about to write a "state" onto something, stop and ask which of the
two you mean. If the answer is "who governs it", it belongs to the jurisdiction.
If the answer is "where the person sits", it belongs to a geographic area. If
the answer is "both", they are two facts and they get two columns.
