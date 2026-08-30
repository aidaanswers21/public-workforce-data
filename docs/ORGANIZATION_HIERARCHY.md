# Organization hierarchy

## Why there is no parent column

A single `parent_id` on `organizations` would answer one question badly and
several questions not at all.

Public bodies do not sit in one clean tree. A school belongs to a district, but
a charter school may be operated by a management organization while being
overseen by a state agency. A county department reports to a county, which is
inside a state, which does not govern the federal building down the road. A
regional office belongs to a federal agency and sits in a state that has no
authority over it. Agencies merge, split, get absorbed and get renamed, and a
`parent_id` overwrite loses every one of those events.

So the hierarchy is a table of its own.

## `organization_relationships`

One row per relationship, each with:

| Column                   | Meaning                            |
| ------------------------ | ---------------------------------- |
| `child_organization_id`  | The subordinate organization       |
| `parent_organization_id` | The superior organization          |
| `relationship_type_code` | Which kind of relationship this is |
| `effective_from`         | When it started, if known          |
| `effective_to`           | When it ended, null while current  |
| provenance               | The document that said so          |

Relationship types, from `@pan/taxonomy`:

| Code              | Implies subtree | Meaning                                    |
| ----------------- | --------------- | ------------------------------------------ |
| `part_of`         | yes             | The child is a component of the parent     |
| `reports_to`      | yes             | The child answers to the parent            |
| `operated_by`     | yes             | An operator runs the child                 |
| `oversees`        | no              | Regulatory or supervisory, not containment |
| `succeeds`        | no              | The child replaced the parent              |
| `merged_into`     | no              | The child was absorbed by the parent       |
| `affiliated_with` | no              | An association with no authority implied   |

`implies_subtree` is the load-bearing flag. Only those three types make an
organization part of another's subtree. Oversight does not: a state agency that
regulates a utility does not employ its staff, and suppressing the regulator
must not withhold the utility.

## Reading ancestry

Two implementations, deliberately.

**In SQL**, `ORG_ANCESTRY_CTE` in `packages/database/src/repositories/queries.ts`
walks the relationship table with a recursive CTE, filtered to relationship
types where `implies_subtree` is true and to rows effective at the query time.
`OrganizationRepository.ancestorsOf` and `descendantsOf` expose it directly.

**In memory**, `OrganizationHierarchy` in `@pan/core` mirrors the same rule for
code paths that already hold the graph, including the export re-check. It walks
breadth-first and is cycle-safe: a relationship loop produced by bad source data
yields a finite ancestor set rather than hanging.

Both exist because subtree suppression is enforced twice, in SQL and again in
memory immediately before an export is written. Implementing the rule once and
calling it from both places would be tidier and would also mean a single bug
disables both checks.

## Effective dating

A relationship carries a window, and every ancestry query takes a timestamp.
Asking "who was above this office in March" and "who is above it today" are the
same query with a different `at`.

When an organization moves, the old relationship is closed with an
`effective_to` and a new one is opened. Nothing is deleted, so the record of the
reorganization survives, and an export reproduced for an earlier date resolves
the hierarchy that was true then.

`tests/extensibility.test.ts` construction 7 builds an organization whose parent
changes over time and asserts that ancestry at the earlier date and ancestry at
the later date both resolve correctly.

## Federal organizations have no state above them

Nothing in this model requires a state. A federal agency's relationships point
at other federal organizations, its jurisdiction is `us-federal` at the
`federal` government level, and its regional offices sit in geographic areas
that have no authority over them.

`validateJurisdictionConfig` reports an error if a federal jurisdiction
configuration names a state as an organizational parent, so the mistake is
caught at configuration time rather than becoming a bad row.

`tests/extensibility.test.ts` construction 9 builds a federal worker with a duty
location in a state, no state organizational parent anywhere in their ancestry,
and asserts the export still carries a correct duty location.

## Units are not organizations

An organization's internal structure lives in `organizational_units`:
departments, divisions, bureaus, offices. A unit belongs to exactly one
organization and is not part of the relationship graph.

The line is about who is the employer. A city's Parks Department is a unit of
the city. A regional transit authority that the city helped create is a separate
organization with a `part_of` or `affiliated_with` relationship, because it
employs its own people and can be suppressed on its own.
