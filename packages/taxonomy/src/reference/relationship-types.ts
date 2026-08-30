import { indexByCode, type RelationshipTypeRow } from './types.js';

/**
 * How two organizations relate, over time.
 *
 * Relationships are effective-dated rows rather than a `parent_id` column,
 * because public-sector reporting lines change, overlap and occasionally run in
 * more than one direction at once. `impliesSubtree` marks the relationships
 * that suppression and coverage roll up through.
 */
export const RELATIONSHIP_TYPES: readonly RelationshipTypeRow[] = [
  {
    code: 'part_of',
    name: 'Part of',
    description:
      'The child is organizationally part of the parent. The ordinary containment relationship.',
    readingFromChild: 'is part of',
    impliesSubtree: true,
  },
  {
    code: 'reports_to',
    name: 'Reports to',
    description:
      'The child reports to the parent without being contained by it, such as a board-appointed office.',
    readingFromChild: 'reports to',
    impliesSubtree: true,
  },
  {
    code: 'operated_by',
    name: 'Operated by',
    description: 'The parent operates the child, such as an authority running a facility.',
    readingFromChild: 'is operated by',
    impliesSubtree: true,
  },
  {
    code: 'oversees',
    name: 'Oversees',
    description: 'The parent has oversight of the child without operating it.',
    readingFromChild: 'is overseen by',
    impliesSubtree: false,
  },
  {
    code: 'succeeds',
    name: 'Succeeds',
    description: 'The child organization succeeded the parent, which no longer operates.',
    readingFromChild: 'succeeds',
    impliesSubtree: false,
  },
  {
    code: 'merged_into',
    name: 'Merged into',
    description: 'The child was merged into the parent.',
    readingFromChild: 'merged into',
    impliesSubtree: false,
  },
  {
    code: 'affiliated_with',
    name: 'Affiliated with',
    description: 'A working relationship that is neither containment nor reporting.',
    readingFromChild: 'is affiliated with',
    impliesSubtree: false,
  },
];

export const RELATIONSHIP_TYPES_BY_CODE = indexByCode(RELATIONSHIP_TYPES);

/** Relationship codes that suppression and coverage roll up through. */
export const SUBTREE_RELATIONSHIP_CODES: readonly string[] = RELATIONSHIP_TYPES.filter(
  (row) => row.impliesSubtree,
).map((row) => row.code);
