/**
 * Controlled reference data.
 *
 * These vocabularies are data, not Postgres enums. Adding an organization type,
 * a sector or a role category means adding a row here and re-running the
 * reference-data seeder. It never means writing a migration, which is what
 * keeps the platform open to public-sector shapes nobody has enumerated yet.
 */
export interface ReferenceRow {
  /** Stable, lower_snake_case, never renamed once published. */
  code: string;
  name: string;
  description: string;
  /** Set when a code is retired. Retired codes are kept so old rows still resolve. */
  retiredAt?: string;
}

/**
 * A kind of public body.
 *
 * The level and sector here are **defaults**, not constraints. Government level
 * and sector are orthogonal, independently recorded attributes of an
 * organization, and the source decides both. A school district is an
 * independent special district in most states and a department of a city or
 * county in others; both are `school_district`, and the platform records what
 * the source actually supports rather than what the type would prefer.
 *
 * A null default means the type genuinely varies and the caller must state the
 * value. There is no composite foreign key from an organization to a
 * (type, level, sector) triple, because such a key would force every school, or
 * every public authority, into one level and one sector forever.
 */
export interface OrganizationTypeRow extends ReferenceRow {
  /** Usual level for this type. Null when it genuinely varies. */
  defaultGovernmentLevelCode: string | null;
  /** Usual sector for this type. Null when it genuinely varies. */
  defaultSectorCode: string | null;
  /** True when organizations of this type are normally subordinate to another. */
  typicallySubordinate: boolean;
}

export interface IdentifierSystemRow extends ReferenceRow {
  /** Which entity the identifier names. */
  appliesTo: 'organization' | 'geographic_area' | 'person' | 'jurisdiction';
  /** Expected shape, used to reject obviously wrong values on import. */
  pattern: string | null;
  authority: string;
}

export interface RelationshipTypeRow extends ReferenceRow {
  /** How to read the pair, e.g. "child is part of parent". */
  readingFromChild: string;
  /** True when the relationship implies the child inherits the parent's suppression. */
  impliesSubtree: boolean;
}

export function indexByCode<T extends ReferenceRow>(rows: readonly T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (map.has(row.code)) throw new Error(`duplicate reference code "${row.code}"`);
    map.set(row.code, row);
  }
  return map;
}
