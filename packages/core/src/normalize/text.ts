const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const EXOTIC_SPACE = /[\u00A0\u2007\u202F\u2009\u2002\u2003]/g;
const COMBINING_MARKS = /[\u0300-\u036F]/g;

/** Collapse whitespace, strip zero-width and exotic space characters, trim. */
export function collapseWhitespace(value: string): string {
  return value
    .replace(ZERO_WIDTH, '')
    .replace(EXOTIC_SPACE, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Lowercase, unaccent, strip punctuation, hyphen-join. The key used for exact matching. */
export function normalizeKey(value: string): string {
  return collapseWhitespace(value)
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ +/g, '-');
}

export function titleCase(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (_match, c: string) => c.toUpperCase());
}

/** True when a string is written entirely in capitals, a common directory style. */
export function isShouting(value: string): boolean {
  const letters = value.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

/** Restore sane casing only when the source was shouting; otherwise leave it alone. */
export function decaseIfShouting(value: string): string {
  const cleaned = collapseWhitespace(value);
  return isShouting(cleaned) ? titleCase(cleaned) : cleaned;
}

/**
 * Normalize a county name to its bare form.
 *
 * Source files disagree on "Harris", "Harris County", "HARRIS CO." and
 * "County of Harris". The bare form is what we key on; the original is kept in
 * `sourceValue` so nothing is lost.
 */
export function normalizeCountyName(raw: string): string {
  let value = collapseWhitespace(raw);
  value = value.replace(/^county\s+of\s+/i, '');
  value = value.replace(/\s+(county|co\.?|parish|borough)\s*$/i, '');
  value = value.replace(/[.,]+$/, '');
  return decaseIfShouting(value);
}

const DISTRICT_SUFFIX =
  /\b(independent school district|unified school district|consolidated school district|school district|public schools|isd|usd|cisd|schools|district)\b/gi;

/**
 * Collapse dotted acronyms so "I.S.D." and "ISD" are the same token.
 * Districts publish both spellings, sometimes on the same page.
 */
export function collapseDottedAcronyms(value: string): string {
  return value.replace(/\b(?:[a-z]\.){2,}/gi, (match) => match.replace(/\./g, ''));
}

/** Comparable district name: suffixes and punctuation removed, case folded. */
export function normalizeDistrictName(raw: string): string {
  const collapsed = collapseDottedAcronyms(collapseWhitespace(raw));
  return normalizeKey(collapsed.replace(DISTRICT_SUFFIX, ' '));
}

/** Comparable school name. "Elementary School" and "Elementary" collapse together. */
export function normalizeSchoolName(raw: string): string {
  const stripped = collapseWhitespace(raw).replace(
    /\b(elementary|middle|junior high|high|primary|intermediate)\s+school\b/gi,
    '$1',
  );
  return normalizeKey(stripped);
}

const DEPARTMENT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['hr', 'Human Resources'],
  ['human-resource', 'Human Resources'],
  ['human-resources', 'Human Resources'],
  ['it', 'Technology'],
  ['information-technology', 'Technology'],
  ['technology-services', 'Technology'],
  ['business-office', 'Business and Finance'],
  ['finance', 'Business and Finance'],
  ['business-services', 'Business and Finance'],
  ['sped', 'Special Education'],
  ['special-ed', 'Special Education'],
  ['special-education', 'Special Education'],
  ['front-office', 'Front Office'],
  ['main-office', 'Front Office'],
  ['athletics', 'Athletics'],
  ['child-nutrition', 'Child Nutrition'],
  ['food-services', 'Child Nutrition'],
  ['food-service', 'Child Nutrition'],
  ['transportation', 'Transportation'],
  ['maintenance', 'Operations and Facilities'],
  ['facilities', 'Operations and Facilities'],
  ['operations', 'Operations and Facilities'],
]);

export function normalizeDepartmentName(raw: string): string {
  const alias = DEPARTMENT_ALIASES.get(normalizeKey(raw));
  if (alias !== undefined) return alias;
  const cleaned = collapseWhitespace(raw).replace(/\s*(department|dept\.?|office)\s*$/i, '');
  return decaseIfShouting(cleaned);
}

/** Digits-only US phone, formatted, or null when the input is not a usable number. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}
