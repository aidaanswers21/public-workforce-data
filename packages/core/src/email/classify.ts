import type { EmailClassification, ObfuscationKind } from '@pan/shared-types';
import { nameTokens, type ParsedName } from '../normalize/names.js';
import { isSyntacticallyValidEmail } from './obfuscation.js';

export type EmailOrigin = 'observed' | 'inferred';

export interface SharedInboxVocabulary {
  /** Local parts that name a shared or role inbox rather than one person. */
  localParts: readonly string[];
  /** Prefixes that mark a shared inbox even with a suffix attached. */
  prefixes: readonly string[];
}

export interface ClassifyEmailInput {
  address: string;
  obfuscation: ObfuscationKind;
  origin: EmailOrigin;
  /** When known, used to decide "shared inbox" versus "this person's address". */
  personName?: Pick<ParsedName, 'firstName' | 'middleName' | 'lastName'> | null;
  /** Supplied from the composed vocabulary. Empty means "no shared-inbox knowledge". */
  sharedInbox?: SharedInboxVocabulary;
}

export interface ClassifyEmailResult {
  classification: EmailClassification;
  /** True when the local part reads as a shared inbox. */
  isGeneralInbox: boolean;
  /** True when the local part contains a recognizable part of the person's name. */
  matchesPersonName: boolean;
  reasons: readonly string[];
}

/**
 * Decide which data class an address belongs to.
 *
 * Never returns `suppressed`: suppression is an overlay applied by the
 * suppression layer at query and export time, not a property of the address
 * itself. Never returns `inferred_candidate` for an observed address, and never
 * returns `published` for an inferred one.
 */
export function classifyEmail(input: ClassifyEmailInput): ClassifyEmailResult {
  const address = input.address.trim().toLowerCase();
  const reasons: string[] = [];

  if (!isSyntacticallyValidEmail(address)) {
    return {
      classification: 'invalid',
      isGeneralInbox: false,
      matchesPersonName: false,
      reasons: ['failed syntax check'],
    };
  }

  const localPart = address.split('@')[0] ?? '';
  const compactLocal = localPart.replace(/[._-]/g, '');
  const knownLocalParts = new Set(input.sharedInbox?.localParts ?? []);
  const knownPrefixes = input.sharedInbox?.prefixes ?? [];
  const isGeneralInbox =
    knownLocalParts.has(localPart) ||
    knownLocalParts.has(compactLocal) ||
    knownPrefixes.some(
      (prefix) =>
        compactLocal.startsWith(prefix) &&
        compactLocal.length <= prefix.length + 12 &&
        !/\d{3,}/.test(compactLocal),
    );

  const matchesPersonName = input.personName
    ? localPartMatchesName(localPart, input.personName)
    : false;

  if (isGeneralInbox && !matchesPersonName) {
    reasons.push('local part is a known shared or role inbox');
    return { classification: 'general_inbox', isGeneralInbox: true, matchesPersonName, reasons };
  }

  if (input.origin === 'inferred') {
    reasons.push('generated from a domain pattern, never observed on a source page');
    return {
      classification: 'inferred_candidate',
      isGeneralInbox,
      matchesPersonName,
      reasons,
    };
  }

  if (input.obfuscation === 'none') {
    reasons.push('displayed in plain text by the source');
    return { classification: 'published', isGeneralInbox, matchesPersonName, reasons };
  }

  reasons.push(`publicly displayed, decoded from ${input.obfuscation}`);
  return { classification: 'decoded_published', isGeneralInbox, matchesPersonName, reasons };
}

/** True when the local part plausibly encodes this person's name. */
export function localPartMatchesName(
  localPart: string,
  parsed: Pick<ParsedName, 'firstName' | 'middleName' | 'lastName'>,
): boolean {
  const tokens = nameTokens(parsed);
  if (tokens.first.length === 0 && tokens.last.length === 0) return false;
  const compact = localPart.toLowerCase().replace(/[^a-z]/g, '');
  if (compact.length < 3) return false;

  if (tokens.last.length >= 3 && compact.includes(tokens.last)) return true;
  if (tokens.first.length >= 3 && compact.includes(tokens.first)) return true;
  if (
    tokens.firstInitial.length === 1 &&
    tokens.last.length >= 3 &&
    compact === tokens.firstInitial + tokens.last
  ) {
    return true;
  }
  if (
    tokens.first.length >= 3 &&
    tokens.lastInitial.length === 1 &&
    compact === tokens.first + tokens.lastInitial
  ) {
    return true;
  }
  return false;
}

/**
 * A published address always wins over an inferred one.
 *
 * Returns true only when the incoming classification may replace the stored one.
 * The database enforces the same rule, so this is a fast pre-check rather than
 * the only line of defence.
 */
export function canReplaceClassification(
  stored: EmailClassification,
  incoming: EmailClassification,
): boolean {
  const rank: Record<EmailClassification, number> = {
    invalid: 0,
    suppressed: 0,
    inferred_candidate: 1,
    general_inbox: 2,
    decoded_published: 3,
    published: 4,
  };
  return rank[incoming] > rank[stored];
}
