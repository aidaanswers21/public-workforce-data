import type { Uuid } from '@pan/shared-types';

/**
 * Education-specific attributes, held in an extension table keyed to
 * `organizations.id`.
 *
 * These never appear on the neutral organization row. A county government has
 * no grade range, and adding nullable education columns to a shared table is
 * how a neutral model quietly stops being neutral.
 */
export interface EducationOrganizationAttributes {
  organizationId: Uuid;
  /** Lowest grade served, as published. Not normalized to a number: sources use PK, KG, K, 01. */
  lowGrade: string | null;
  highGrade: string | null;
  /** As published, e.g. "Elementary", "High School", "Alternative". */
  schoolType: string | null;
  /** Regular, charter, magnet, alternative, virtual. Published value retained. */
  operationalStatus: string | null;
  isCharter: boolean | null;
  isMagnet: boolean | null;
  isVirtual: boolean | null;
  /** Reported enrolment, with the year it applies to. */
  enrollment: number | null;
  enrollmentAsOf: string | null;
  titleOneStatus: string | null;
}

export const EDUCATION_ATTRIBUTE_TABLE = 'education_organization_attributes';

/** Grade tokens as published, in the order sources normally use. */
export const GRADE_TOKENS: readonly string[] = [
  'PK',
  'KG',
  'K',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  'AE',
  'UG',
  'NA',
];

/**
 * Normalize a published grade token without inventing one.
 *
 * Returns null rather than guessing when the token is unrecognized, so an
 * unusual source shows up as a gap instead of a wrong value.
 */
export function normalizeGradeToken(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/^GRADE\s*/, '');
  if (cleaned.length === 0) return null;
  if (/^(PRE-?K|PK|PREKINDERGARTEN)$/.test(cleaned)) return 'PK';
  if (/^(K|KG|KINDERGARTEN)$/.test(cleaned)) return 'KG';
  const numeric = /^(\d{1,2})(ST|ND|RD|TH)?$/.exec(cleaned);
  if (numeric !== null) {
    const value = Number(numeric[1]);
    if (value >= 1 && value <= 12) return String(value).padStart(2, '0');
  }
  return GRADE_TOKENS.includes(cleaned) ? cleaned : null;
}
