import type { NormalizationMethod } from '@pan/shared-types';
import type { TitleAbbreviation, TitleRule } from '@pan/taxonomy';
import { collapseWhitespace, decaseIfShouting, normalizeKey } from './text.js';

/**
 * The rules a title normalization runs against.
 *
 * Supplied by the caller, composed in `@pan/taxonomy` from a neutral base plus
 * whatever the registered sectors contribute. The neutral core knows how to
 * apply rules and nothing at all about what any particular public body calls
 * its people.
 */
export interface TitleRuleSet {
  rules: readonly TitleRule[];
  abbreviations: readonly TitleAbbreviation[];
  /** Modifiers that override seniority regardless of the matched rule. */
  seniorityModifiers: readonly { test: RegExp; seniorityCode: string }[];
  /** Role category code to fall back to when nothing matches. */
  fallbackRoleCategoryCode: string;
  unknownRoleCategoryCode: string;
  /** Maps a role category to its job family. */
  jobFamilyForRole: (roleCategoryCode: string) => string;
  /**
   * Patterns that pull a specialty out of a title: a subject, a beat, a grade
   * band. Supplied by the taxonomy, because what counts as a specialty is a
   * fact about a vertical.
   */
  specialtyPatterns: readonly RegExp[];
  /** Recorded on every normalization so a re-run is comparable. */
  version: string;
}

export interface NormalizedTitle {
  titlePublished: string | null;
  titleNormalized: string;
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  specialty: string | null;
  method: NormalizationMethod;
  /** Which pack contributed the matched rule. */
  ruleSource: string | null;
  taxonomyVersion: string;
  confidence: number;
}

/**
 * Normalize a published title against a rule set.
 *
 * The published string is preserved untouched. An unmatched title becomes the
 * fallback category with low confidence rather than being dropped, so coverage
 * reporting can surface titles the taxonomy does not yet know instead of
 * silently absorbing them.
 */
export function normalizeTitle(
  raw: string | null | undefined,
  ruleSet: TitleRuleSet,
): NormalizedTitle {
  const titlePublished = raw == null ? null : collapseWhitespace(raw);

  if (titlePublished === null || titlePublished.length === 0) {
    return {
      titlePublished,
      titleNormalized: '',
      roleCategoryCode: ruleSet.unknownRoleCategoryCode,
      jobFamilyCode: ruleSet.jobFamilyForRole(ruleSet.unknownRoleCategoryCode),
      seniorityCode: 'unknown',
      specialty: null,
      method: 'rule_table',
      ruleSource: null,
      taxonomyVersion: ruleSet.version,
      confidence: 0,
    };
  }

  let expanded = decaseIfShouting(titlePublished);
  for (const abbreviation of ruleSet.abbreviations) {
    expanded = expanded.replace(abbreviation.pattern, abbreviation.expansion);
  }
  expanded = expanded
    .replace(/\s*[/|]\s*/g, ' / ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const key = normalizeKey(expanded);
  const matched = ruleSet.rules.find((rule) => rule.test.test(key));

  let specialty: string | null = null;
  for (const pattern of ruleSet.specialtyPatterns) {
    const match = pattern.exec(titlePublished);
    if (match?.[0] !== undefined) {
      specialty = decaseIfShouting(match[0]);
      break;
    }
  }

  const roleCategoryCode = matched?.roleCategoryCode ?? ruleSet.fallbackRoleCategoryCode;
  let seniorityCode = matched?.seniorityCode ?? 'unknown';
  for (const modifier of ruleSet.seniorityModifiers) {
    if (modifier.test.test(key)) {
      seniorityCode = modifier.seniorityCode;
      break;
    }
  }

  return {
    titlePublished,
    titleNormalized: expanded,
    roleCategoryCode,
    jobFamilyCode: ruleSet.jobFamilyForRole(roleCategoryCode),
    seniorityCode,
    specialty,
    method: 'rule_table',
    ruleSource: matched?.source ?? null,
    taxonomyVersion: ruleSet.version,
    confidence: matched === undefined ? 0.2 : (matched.confidence ?? 0.9),
  };
}

/**
 * True when a string looks like a job title rather than a person's name.
 * Used to reject header rows and mis-aligned table columns.
 */
export function looksLikeTitle(value: string, ruleSet: TitleRuleSet): boolean {
  const key = normalizeKey(value);
  if (key.length === 0) return false;
  if (/^(name|staff|employee|title|position|email|phone|department|office|organization)$/.test(key))
    return true;
  return ruleSet.rules.some((rule) => rule.test.test(key));
}
