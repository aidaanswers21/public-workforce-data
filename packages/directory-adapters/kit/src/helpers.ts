import type {
  DirectoryVocabulary,
  ExtractedEmail,
  ExtractedPersonRecord,
  ExtractionMethod,
} from '@public-workforce/shared-types';
import {
  collapseWhitespace,
  decodeCloudflareEmail,
  deterministicRecordKey,
  extractEmailsFromText,
  isSyntacticallyValidEmail,
  normalizePhone,
  parseMailtoHref,
  parsePersonName,
  classifyEmail,
  isOrganizationLabel,
} from '@public-workforce/core';

export interface RecordDraft {
  adapterKey: string;
  sourceUrl: string;
  /** Whatever identifies this row on this page: a profile href, a staff id, or name + ordinal. */
  localKey: string;
  fullNamePublished: string;
  titlePublished?: string | null;
  departmentPublished?: string | null;
  organizationPublished?: string | null;
  phonePublished?: string | null;
  profileUrl?: string | null;
  /** Any text that may contain addresses: cell contents, mailto hrefs, data attributes. */
  emailSources?: readonly string[];
  /** Raw `data-cfemail` values found within this record's markup. */
  cloudflareEncoded?: readonly string[];
  extractionMethod: ExtractionMethod;
  confidence: number;
  selector?: string | null;
  snippet?: string | null;
  /**
   * Composed from the registered sectors.
   *
   * Required, because deciding whether a row names a person or an office is a
   * vocabulary question, and an adapter that guessed would quietly become
   * specific to one vertical.
   */
  vocabulary: DirectoryVocabulary;
}

/**
 * Assemble one extracted record, decoding every form of published address.
 *
 * Adapters call this instead of building records by hand so that email decoding,
 * shared-inbox detection and record-key derivation behave identically on every
 * platform. Nothing here invents a value: a field the page did not publish stays
 * null.
 */
export function buildPersonRecord(draft: RecordDraft): ExtractedPersonRecord | null {
  const fullNamePublished = collapseWhitespace(draft.fullNamePublished);
  if (fullNamePublished.length === 0) return null;

  const parsed = parsePersonName(fullNamePublished);
  // "Front Office" parses as a name whose surname is "Office", which would
  // otherwise make office@ look like that person's own address. An organization
  // label vouches for nothing.
  const nameForClassification = isOrganizationLabel(
    fullNamePublished,
    draft.vocabulary.organizationLabelWords,
  )
    ? null
    : parsed;
  const emails = new Map<string, ExtractedEmail>();

  const addEmail = (candidate: {
    raw: string;
    address: string;
    obfuscation: ExtractedEmail['obfuscation'];
  }): void => {
    const address = candidate.address.trim().toLowerCase();
    if (!isSyntacticallyValidEmail(address)) return;
    if (emails.has(address)) return;
    const classification = classifyEmail({
      address,
      obfuscation: candidate.obfuscation,
      origin: 'observed',
      personName: nameForClassification,
      sharedInbox: {
        localParts: draft.vocabulary.sharedInboxLocalParts,
        prefixes: draft.vocabulary.sharedInboxPrefixes,
      },
    });
    emails.set(address, {
      raw: candidate.raw,
      address,
      obfuscation: candidate.obfuscation,
      looksLikeGeneralInbox: classification.isGeneralInbox && !classification.matchesPersonName,
    });
  };

  for (const source of draft.emailSources ?? []) {
    const mailto = parseMailtoHref(source);
    if (mailto !== null) {
      addEmail(mailto);
      continue;
    }
    for (const found of extractEmailsFromText(source)) addEmail(found);
  }

  for (const encoded of draft.cloudflareEncoded ?? []) {
    const decoded = decodeCloudflareEmail(encoded);
    if (decoded !== null) {
      addEmail({
        raw: `data-cfemail=${encoded}`,
        address: decoded,
        obfuscation: 'cloudflare_cfemail',
      });
    }
  }

  const phone = draft.phonePublished == null ? null : normalizePhone(draft.phonePublished);

  return {
    recordKey: deterministicRecordKey({
      adapterKey: draft.adapterKey,
      sourceUrl: draft.sourceUrl,
      localKey: draft.localKey,
    }),
    fullNamePublished,
    titlePublished: emptyToNull(draft.titlePublished),
    departmentPublished: emptyToNull(draft.departmentPublished),
    organizationPublished: emptyToNull(draft.organizationPublished),
    phonePublished: phone,
    emails: [...emails.values()],
    profileUrl: emptyToNull(draft.profileUrl),
    extractionMethod: draft.extractionMethod,
    confidence: clamp01(draft.confidence),
    selector: emptyToNull(draft.selector),
    snippet: emptyToNull(draft.snippet),
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = collapseWhitespace(value);
  return cleaned.length === 0 ? null : cleaned;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Reject strings that are structurally not personal names.
 *
 * Table parsers pick up header rows, "Back to top" links and empty cells. This
 * is the gate that keeps them out of the person table.
 */
export function looksLikePersonName(value: string): boolean {
  const cleaned = collapseWhitespace(value);
  if (cleaned.length < 3 || cleaned.length > 120) return false;
  if (!/[a-z]/i.test(cleaned)) return false;
  if (
    /^(name|staff|employee|title|position|email|phone|department|back to top|more|view|details)$/i.test(
      cleaned,
    )
  ) {
    return false;
  }
  if (/^\d+$/.test(cleaned)) return false;
  if (/(click here|read more|learn more|contact us|view profile)/i.test(cleaned)) return false;
  if (cleaned.split(/\s+/).length > 6) return false;
  if (cleaned.includes('@')) return false;
  return true;
}
