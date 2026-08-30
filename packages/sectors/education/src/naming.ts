import { collapseDottedAcronyms, collapseWhitespace, normalizeKey } from '@pan/core';

/**
 * Education organization name normalization.
 *
 * Lives here rather than in the core because "Sample ISD" and "Sample
 * Independent School District" being the same organization is a fact about
 * education, not about public bodies generally.
 */
const DISTRICT_SUFFIX =
  /\b(independent school district|unified school district|consolidated school district|school district|public schools|isd|usd|cisd|schools|district)\b/gi;

const SCHOOL_LEVEL_SUFFIX =
  /\b(elementary|middle|junior high|high|primary|intermediate)\s+school\b/gi;

/** Comparable district name: suffix variants and punctuation removed, case folded. */
export function normalizeDistrictName(raw: string): string {
  const collapsed = collapseDottedAcronyms(collapseWhitespace(raw));
  return normalizeKey(collapsed.replace(DISTRICT_SUFFIX, ' '));
}

/** Comparable school name. "Oak Ridge Elementary School" and "Oak Ridge Elementary" collapse together. */
export function normalizeSchoolName(raw: string): string {
  return normalizeKey(collapseWhitespace(raw).replace(SCHOOL_LEVEL_SUFFIX, '$1'));
}

/** Pick the right normalizer for an education organization type. */
export function normalizeEducationOrganizationName(
  raw: string,
  organizationTypeCode: string,
): string {
  return organizationTypeCode === 'school' ? normalizeSchoolName(raw) : normalizeDistrictName(raw);
}
