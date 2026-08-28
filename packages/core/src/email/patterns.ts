import type { EmailPatternEvidence } from '@pan/shared-types';
import { nameTokens, type ParsedName } from '../normalize/names.js';
import { isSyntacticallyValidEmail } from './obfuscation.js';

/**
 * Supported local-part patterns, most specific first.
 *
 * Tokens: {first} {last} {middle} {f} {l} {m}. Anything not in this list is not
 * a pattern we will infer from; unusual conventions must be added here
 * deliberately rather than guessed at run time.
 */
export const SUPPORTED_PATTERNS: readonly string[] = [
  '{first}.{last}',
  '{first}_{last}',
  '{first}-{last}',
  '{first}{last}',
  '{f}{last}',
  '{f}.{last}',
  '{first}{l}',
  '{first}.{l}',
  '{last}{f}',
  '{last}.{first}',
  '{last}{first}',
  '{f}{m}{last}',
  '{first}.{m}.{last}',
  '{first}',
  '{last}',
];

export interface NameTokenSet {
  first: string;
  middle: string;
  last: string;
  firstInitial: string;
  middleInitial: string;
  lastInitial: string;
}

/**
 * Render a pattern for a name, or null when the name lacks a required token.
 *
 * Returning null instead of a partial string is deliberate: a pattern that
 * needs a middle initial must not silently produce "jane..smith".
 */
export function renderPattern(pattern: string, tokens: NameTokenSet): string | null {
  const substitutions: Record<string, string> = {
    '{first}': tokens.first,
    '{last}': tokens.last,
    '{middle}': tokens.middle,
    '{f}': tokens.firstInitial,
    '{l}': tokens.lastInitial,
    '{m}': tokens.middleInitial,
  };
  let out = pattern;
  for (const [token, value] of Object.entries(substitutions)) {
    if (!out.includes(token)) continue;
    if (value.length === 0) return null;
    out = out.split(token).join(value);
  }
  if (/[{}]/.test(out)) return null;
  return out.toLowerCase();
}

/** Every supported pattern whose rendering equals this local part. */
export function patternsMatching(localPart: string, parsed: ParsedName): string[] {
  const tokens = nameTokens(parsed);
  const target = localPart.trim().toLowerCase();
  return SUPPORTED_PATTERNS.filter((pattern) => renderPattern(pattern, tokens) === target);
}

export interface PublishedNamePair {
  parsed: ParsedName;
  address: string;
}

export interface LearnedPattern extends EmailPatternEvidence {
  domain: string;
}

export interface LearnOptions {
  /** Minimum published examples before a pattern may be used at all. */
  minSupport?: number;
  /** Minimum share of the domain's published addresses the pattern must explain. */
  minConsistency?: number;
}

export const DEFAULT_LEARN_OPTIONS: Required<LearnOptions> = {
  minSupport: 3,
  minConsistency: 0.8,
};

/**
 * Learn the dominant local-part convention for one domain from published addresses.
 *
 * Only addresses that already belong to a known person are usable as evidence.
 * Shared inboxes must be excluded by the caller: counting `info@district.org`
 * as a failed pattern match would depress consistency for no reason.
 */
export function learnDomainPatterns(
  domain: string,
  pairs: readonly PublishedNamePair[],
  options: LearnOptions = {},
): LearnedPattern[] {
  const { minSupport, minConsistency } = { ...DEFAULT_LEARN_OPTIONS, ...options };
  const normalizedDomain = domain.trim().toLowerCase();

  const usable = pairs.filter((pair) => {
    const [, addressDomain] = pair.address.toLowerCase().split('@');
    return addressDomain === normalizedDomain;
  });
  if (usable.length === 0) return [];

  const supportByPattern = new Map<string, string[]>();
  for (const pair of usable) {
    const localPart = pair.address.toLowerCase().split('@')[0] ?? '';
    for (const pattern of patternsMatching(localPart, pair.parsed)) {
      const bucket = supportByPattern.get(pattern);
      if (bucket) bucket.push(pair.address.toLowerCase());
      else supportByPattern.set(pattern, [pair.address.toLowerCase()]);
    }
  }

  const learned: LearnedPattern[] = [];
  for (const [pattern, examples] of supportByPattern) {
    const supportCount = examples.length;
    const conflictCount = usable.length - supportCount;
    const consistency = supportCount / usable.length;
    if (supportCount < minSupport) continue;
    if (consistency < minConsistency) continue;
    learned.push({
      domain: normalizedDomain,
      pattern,
      supportingExamples: examples.slice(0, 10),
      supportCount,
      conflictCount,
      consistency,
    });
  }

  return learned.sort((a, b) => b.consistency - a.consistency || b.supportCount - a.supportCount);
}

export interface GeneratedCandidate {
  address: string;
  domain: string;
  pattern: string;
  evidence: EmailPatternEvidence;
  /**
   * Confidence in the inference only.
   *
   * This is not a deliverability signal and must never be presented as one. An
   * address is "verified" only when an `email_validation_results` row says so.
   */
  confidence: number;
}

/**
 * Generate an inferred address for one person on one domain.
 *
 * Returns null when the pattern cannot be rendered for this name or when the
 * result is not a syntactically valid address. Callers must run this as a
 * separate asynchronous pass, never inline during extraction, so that inferred
 * data can never be mistaken for something a page actually published.
 */
export function generateCandidate(
  parsed: ParsedName,
  learned: LearnedPattern,
): GeneratedCandidate | null {
  const localPart = renderPattern(learned.pattern, nameTokens(parsed));
  if (localPart === null) return null;
  const address = `${localPart}@${learned.domain}`;
  if (!isSyntacticallyValidEmail(address)) return null;

  return {
    address,
    domain: learned.domain,
    pattern: learned.pattern,
    evidence: {
      pattern: learned.pattern,
      supportingExamples: learned.supportingExamples,
      supportCount: learned.supportCount,
      conflictCount: learned.conflictCount,
      consistency: learned.consistency,
    },
    confidence: inferenceConfidence(learned),
  };
}

/**
 * Confidence from evidence strength alone.
 *
 * Consistency dominates; support adds a bounded bonus that saturates at 20
 * examples. Capped at 0.95 because an inferred address is never certain.
 */
export function inferenceConfidence(learned: EmailPatternEvidence): number {
  const supportFactor = Math.min(1, learned.supportCount / 20);
  const raw = learned.consistency * (0.75 + 0.25 * supportFactor);
  return Math.min(0.95, Math.round(raw * 100) / 100);
}
