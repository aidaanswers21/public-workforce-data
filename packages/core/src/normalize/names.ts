import type { NameParts } from '@public-workforce/shared-types';
import { collapseWhitespace, decaseIfShouting, normalizeKey } from './text.js';

const PREFIXES = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'rev',
  'fr',
  'sr',
  'coach',
  'officer',
  'sgt',
  'sergeant',
  'lt',
  'capt',
  'prof',
  'professor',
]);

/**
 * Generational suffixes and post-nominal credentials.
 *
 * Directories put credentials in the same position as generational suffixes, so
 * both are captured here and stored in `suffix` rather than being mistaken for a
 * surname or a first name.
 */
const SUFFIXES = new Set([
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'v',
  'phd',
  'edd',
  'md',
  'do',
  'jd',
  'dds',
  'rn',
  'lvn',
  'bsn',
  'msn',
  'ma',
  'ms',
  'mba',
  'med',
  'ba',
  'bs',
  'bse',
  'mss',
  'mssw',
  'lcsw',
  'lpc',
  'ncc',
  'nbct',
  'cpa',
  'sphr',
  'phr',
  'pe',
  'ate',
  'cdm',
]);

/** Surname particles that belong with the following token, not as a middle name. */
const PARTICLES = new Set([
  'de',
  'del',
  'dela',
  'de la',
  'della',
  'di',
  'da',
  'das',
  'dos',
  'du',
  'van',
  'von',
  'der',
  'den',
  'ter',
  'ten',
  'la',
  'le',
  'los',
  'las',
  'mac',
  'mc',
  'st',
  'st.',
  'san',
  'santa',
  'bin',
  'ibn',
  'al',
]);

const SUFFIX_SORT_ORDER = ['jr', 'sr', 'ii', 'iii', 'iv', 'v'];

function bare(token: string): string {
  return token.replace(/[.,]/g, '').toLowerCase();
}

function isSuffixToken(token: string): boolean {
  return SUFFIXES.has(bare(token));
}

function isPrefixToken(token: string): boolean {
  return PREFIXES.has(bare(token));
}

/** Restore casing for a single name token, preserving Mc/Mac/O' and hyphens. */
function caseNameToken(token: string): string {
  const restored = decaseIfShouting(token);
  return restored
    .replace(/\b(mc)([a-z])/gi, (_m, p: string, c: string) => cap(p) + c.toUpperCase())
    .replace(/\bo'([a-z])/gi, (_m, c: string) => `O'${c.toUpperCase()}`)
    .replace(/-([a-z])/g, (_m, c: string) => `-${c.toUpperCase()}`);
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export interface ParsedName extends NameParts {
  /** The input, whitespace-collapsed. Never altered beyond that. */
  fullNamePublished: string;
  /** Our best single-line rendering, used for display where a source lacks one. */
  displayName: string;
  /** True when the parse fell back to a guess rather than a confident split. */
  lowConfidence: boolean;
}

/**
 * Split a published name into parts.
 *
 * Handles "First Last", "Last, First", credentials after a comma, prefixes,
 * generational suffixes, shouting sources and multi-token surnames with
 * particles. Whatever cannot be split confidently is reported with
 * `lowConfidence: true` rather than being forced into a shape.
 */
export function parsePersonName(raw: string): ParsedName {
  const fullNamePublished = collapseWhitespace(raw);
  const empty: ParsedName = {
    fullNamePublished,
    displayName: fullNamePublished,
    prefix: null,
    firstName: null,
    middleName: null,
    lastName: null,
    suffix: null,
    lowConfidence: true,
  };
  if (fullNamePublished.length === 0) return empty;

  const commaParts = fullNamePublished
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  let working = fullNamePublished;
  const trailingSuffixes: string[] = [];
  let inverted = false;

  if (commaParts.length >= 2) {
    const tail = commaParts.slice(1);
    const credentialTail = tail.filter((part) =>
      part.split(/\s+/).every((token) => isSuffixToken(token)),
    );
    if (credentialTail.length === tail.length) {
      // "Jane Smith, Ed.D." or "John Smith, Jr., Ph.D."
      working = commaParts[0] ?? '';
      for (const part of tail) trailingSuffixes.push(...part.split(/\s+/));
    } else {
      // "Smith, Jane M." with any credentials still trailing. A generational
      // suffix may sit at the end of either part: "Smith, Robert Jr." and
      // "Smith Jr., Robert" are both common.
      inverted = true;
      const [rawSurname, rawGiven, ...rest] = commaParts;
      const surname = takeTrailingSuffixes(rawSurname ?? '', trailingSuffixes);
      const given = takeTrailingSuffixes(rawGiven ?? '', trailingSuffixes);
      working = `${given} ${surname}`.trim();
      for (const part of rest) {
        if (part.split(/\s+/).every((token) => isSuffixToken(token))) {
          trailingSuffixes.push(...part.split(/\s+/));
        }
      }
    }
  }

  const tokens = working.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return empty;

  const prefixes: string[] = [];
  while (tokens.length > 1 && isPrefixToken(tokens[0] as string)) {
    prefixes.push(tokens.shift() as string);
  }
  while (tokens.length > 1 && isSuffixToken(tokens.at(-1) as string)) {
    trailingSuffixes.unshift(tokens.pop() as string);
  }
  if (tokens.length === 0) return empty;

  let firstName: string | null = null;
  let middleName: string | null = null;
  let lastName: string | null = null;
  let lowConfidence = false;

  if (tokens.length === 1) {
    // A mononym or an unsplittable value. Record it as published, flag it.
    lastName = tokens[0] as string;
    lowConfidence = true;
  } else {
    firstName = tokens[0] as string;
    // Absorb surname particles: "Van Der Berg", "de la Cruz".
    let lastStart = tokens.length - 1;
    while (lastStart - 1 >= 1 && PARTICLES.has(bare(tokens[lastStart - 1] as string))) {
      lastStart -= 1;
    }
    lastName = tokens.slice(lastStart).join(' ');
    const middleTokens = tokens.slice(1, lastStart);
    middleName = middleTokens.length > 0 ? middleTokens.join(' ') : null;
  }

  const suffix =
    trailingSuffixes.length > 0
      ? [...new Set(trailingSuffixes.map((token) => token.replace(/,$/, '')))]
          .sort((a, b) => rankSuffix(a) - rankSuffix(b))
          .map(formatSuffix)
          .join(', ')
      : null;

  const parsed: ParsedName = {
    fullNamePublished,
    displayName: '',
    prefix: prefixes.length > 0 ? prefixes.map(caseNameToken).join(' ') : null,
    firstName: firstName === null ? null : caseNameToken(firstName),
    middleName: middleName === null ? null : caseNameToken(middleName),
    lastName: lastName === null ? null : caseNameToken(lastName),
    suffix,
    lowConfidence: lowConfidence || (inverted && tokens.length > 3),
  };
  parsed.displayName = [parsed.firstName, parsed.middleName, parsed.lastName]
    .filter((part): part is string => part !== null)
    .join(' ');
  if (parsed.displayName.length === 0) parsed.displayName = fullNamePublished;
  return parsed;
}

/**
 * Move any trailing suffix tokens out of `part` and into `into`.
 * Returns what is left of the part.
 */
function takeTrailingSuffixes(part: string, into: string[]): string {
  const tokens = part.split(/\s+/).filter(Boolean);
  const taken: string[] = [];
  while (tokens.length > 1 && isSuffixToken(tokens.at(-1) as string)) {
    taken.unshift(tokens.pop() as string);
  }
  into.push(...taken);
  return tokens.join(' ');
}

const ROMAN_SUFFIXES = new Set(['ii', 'iii', 'iv', 'v']);

/** Roman numerals stay upper case; everything else is de-shouted. */
function formatSuffix(token: string): string {
  const key = bare(token);
  if (ROMAN_SUFFIXES.has(key)) return key.toUpperCase();
  if (key === 'jr' || key === 'sr') return `${cap(key)}.`;
  return decaseIfShouting(token);
}

/** Generational suffixes sort before credentials, matching how sources print them. */
function rankSuffix(token: string): number {
  const index = SUFFIX_SORT_ORDER.indexOf(bare(token));
  return index === -1 ? SUFFIX_SORT_ORDER.length : index;
}

/**
 * Stable identity key for a person within one organization.
 *
 * Scoped to the organization rather than to a state, because a federal employee
 * has no state above them and two people with the same name at different public
 * bodies are different people. Middle names are excluded: the same person
 * appears as "Jane Smith" on one page and "Jane M. Smith" on another, and
 * treating those as two people is the largest single source of duplicate rows.
 */
export function personIdentityKey(input: {
  organizationId: string;
  parsed: Pick<ParsedName, 'firstName' | 'lastName' | 'fullNamePublished'>;
}): string {
  const first = input.parsed.firstName ?? '';
  const last = input.parsed.lastName ?? '';
  const nameKey =
    first.length > 0 || last.length > 0
      ? normalizeKey(`${last} ${first}`)
      : normalizeKey(input.parsed.fullNamePublished);
  return [input.organizationId, nameKey].join('|');
}

/** Tokens used for matching a published email local part back to a name. */
export function nameTokens(parsed: Pick<ParsedName, 'firstName' | 'middleName' | 'lastName'>): {
  first: string;
  middle: string;
  last: string;
  firstInitial: string;
  middleInitial: string;
  lastInitial: string;
} {
  const first = normalizeKey(parsed.firstName ?? '').replace(/-/g, '');
  const middle = normalizeKey(parsed.middleName ?? '').replace(/-/g, '');
  const last = normalizeKey(parsed.lastName ?? '').replace(/-/g, '');
  return {
    first,
    middle,
    last,
    firstInitial: first.slice(0, 1),
    middleInitial: middle.slice(0, 1),
    lastInitial: last.slice(0, 1),
  };
}

/**
 * True when every word in the value names an organization rather than a person.
 *
 * Directory rows like "Front Office" or "Records Bureau" parse as names whose
 * surname is a common noun, which would otherwise make a role inbox look like
 * that person's own address. The word list comes from the composed vocabulary,
 * so a vertical can teach it new labels without touching this file. The rule is
 * deliberately conservative: "Jane Office" is a person, "Front Office" is not.
 */
export function isOrganizationLabel(value: string, labelWords: readonly string[]): boolean {
  const words = new Set(labelWords.map((word) => word.toLowerCase()));
  const tokens = collapseWhitespace(value)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => words.has(token));
}
