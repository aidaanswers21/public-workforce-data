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
 * Collapse dotted acronyms so "I.S.D." and "ISD", or "U.S.D.A." and "USDA",
 * are the same token. Public bodies publish both spellings, often on one page.
 */
export function collapseDottedAcronyms(value: string): string {
  return value.replace(/\b(?:[a-z]\.){2,}/gi, (match) => match.replace(/\./g, ''));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a county-equivalent name to its bare form.
 *
 * Source files disagree on "Harris", "Harris County", "HARRIS CO." and
 * "County of Harris", and the same is true of parishes and boroughs. The bare
 * form is what we key on; the original is kept in `sourceValue`.
 */
export function normalizeCountyName(raw: string): string {
  let value = collapseWhitespace(raw);
  value = value.replace(/^county\s+of\s+/i, '');
  value = value.replace(/\s+(county|co\.?|parish|borough)\s*$/i, '');
  value = value.replace(/[.,]+$/, '');
  return decaseIfShouting(value);
}

/**
 * Comparable organization name.
 *
 * The suffixes to drop are supplied by the caller from the composed vocabulary,
 * because what counts as a droppable suffix is a fact about a vertical.
 * "Independent School District", "Board of Supervisors" and "Bureau of" are all
 * suffixes, and none of them belongs hard-coded in the neutral core.
 */
export function normalizeOrganizationName(raw: string, suffixes: readonly string[] = []): string {
  let value = collapseDottedAcronyms(collapseWhitespace(raw));
  // Longest first, so a specific suffix wins over a substring of it.
  for (const suffix of [...suffixes].sort((a, b) => b.length - a.length)) {
    value = value.replace(new RegExp(`\\b${escapeRegExp(suffix)}\\b`, 'gi'), ' ');
  }
  return normalizeKey(value);
}

const UNIT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['hr', 'Human Resources'],
  ['human-resource', 'Human Resources'],
  ['human-resources', 'Human Resources'],
  ['it', 'Information Technology'],
  ['information-technology', 'Information Technology'],
  ['technology-services', 'Information Technology'],
  ['is', 'Information Technology'],
  ['business-office', 'Finance'],
  ['finance', 'Finance'],
  ['business-services', 'Finance'],
  ['fiscal-services', 'Finance'],
  ['front-office', 'Front Office'],
  ['main-office', 'Front Office'],
  ['pw', 'Public Works'],
  ['public-works', 'Public Works'],
  ['dpw', 'Public Works'],
  ['parks-and-rec', 'Parks and Recreation'],
  ['parks-rec', 'Parks and Recreation'],
  ['pd', 'Police'],
  ['fd', 'Fire'],
  ['ems', 'Emergency Medical Services'],
  ['oig', 'Office of Inspector General'],
]);

/**
 * Normalize an organizational unit name.
 *
 * Aliases cover the abbreviations that appear across every level of government.
 * A vertical with its own vocabulary supplies additions through the taxonomy.
 */
export function normalizeUnitName(
  raw: string,
  extraAliases: ReadonlyMap<string, string> = new Map(),
): string {
  const key = normalizeKey(raw);
  const alias = extraAliases.get(key) ?? UNIT_ALIASES.get(key);
  if (alias !== undefined) return alias;
  const cleaned = collapseWhitespace(raw).replace(
    /\s*(department|dept\.?|office|division|bureau)\s*$/i,
    '',
  );
  return decaseIfShouting(cleaned);
}

/** Digits-only US phone, formatted, or null when the input is not a usable number. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}
