import type { ExtractedPersonRecord, Provenance, Timestamp, Uuid } from '@pan/shared-types';
import { normalizeKey } from './normalize/text.js';
import { parsePersonName, personIdentityKey } from './normalize/names.js';

/**
 * Collapse records that describe the same person on the same page.
 *
 * Directories routinely list someone twice (once in a department block, once in
 * an A-Z roster). Merging on `recordKey` first, then on name plus title, keeps
 * one row while preserving every email seen on either copy.
 */
export function dedupeExtractedRecords(
  records: readonly ExtractedPersonRecord[],
): ExtractedPersonRecord[] {
  const byKey = new Map<string, ExtractedPersonRecord>();

  for (const record of records) {
    const existing = byKey.get(record.recordKey);
    byKey.set(record.recordKey, existing ? mergeExtracted(existing, record) : record);
  }

  const bySoftKey = new Map<string, ExtractedPersonRecord>();
  for (const record of byKey.values()) {
    const softKey = softIdentityKey(record);
    const existing = bySoftKey.get(softKey);
    bySoftKey.set(softKey, existing ? mergeExtracted(existing, record) : record);
  }

  return [...bySoftKey.values()];
}

/**
 * Identity of the person a record describes, independent of the page it came from.
 *
 * `recordKey` is deliberately scoped to (adapter, source url) so that recrawling
 * one page is idempotent. That makes it useless for answering "have we already
 * seen this person on a different page", which is what the crawl engine's
 * progress guard needs, so the two keys are kept separate.
 */
export function recordIdentityFingerprint(record: ExtractedPersonRecord): string {
  return softIdentityKey(record);
}

function softIdentityKey(record: ExtractedPersonRecord): string {
  const parsed = parsePersonName(record.fullNamePublished);
  const name = normalizeKey(`${parsed.lastName ?? ''} ${parsed.firstName ?? ''}`);
  const title = normalizeKey(record.titlePublished ?? '');
  const school = normalizeKey(record.schoolPublished ?? '');
  return [name, title, school].join('|');
}

/** Keep the higher-confidence record's fields, union the emails. */
function mergeExtracted(a: ExtractedPersonRecord, b: ExtractedPersonRecord): ExtractedPersonRecord {
  const [primary, secondary] = a.confidence >= b.confidence ? [a, b] : [b, a];
  const emails = new Map(primary.emails.map((email) => [email.address, email]));
  for (const email of secondary.emails) {
    if (!emails.has(email.address)) emails.set(email.address, email);
  }
  return {
    ...primary,
    titlePublished: primary.titlePublished ?? secondary.titlePublished,
    departmentPublished: primary.departmentPublished ?? secondary.departmentPublished,
    schoolPublished: primary.schoolPublished ?? secondary.schoolPublished,
    phonePublished: primary.phonePublished ?? secondary.phonePublished,
    profileUrl: primary.profileUrl ?? secondary.profileUrl,
    emails: [...emails.values()],
  };
}

export interface ResolvablePerson {
  id: Uuid;
  identityKey: string;
  /** Published addresses already attributed to this person. */
  knownEmails: readonly string[];
}

export type PersonMatchStrategy = 'published_email' | 'identity_key' | 'none';

export interface PersonMatch {
  personId: Uuid | null;
  strategy: PersonMatchStrategy;
  confidence: number;
}

/**
 * Resolve an extracted record to an existing person.
 *
 * A published email is the strongest signal and is tried first: two "J. Smith"
 * rows sharing `jsmith@district.org` are the same person, while two identical
 * names in different districts are not. Falling back to the identity key keeps
 * resolution scoped to one organization, so distinct people who happen to share
 * a name across districts stay distinct.
 */
export class PersonResolver {
  private readonly byEmail = new Map<string, Uuid>();
  private readonly byIdentityKey = new Map<string, Uuid>();

  constructor(people: readonly ResolvablePerson[] = []) {
    for (const person of people) this.add(person);
  }

  add(person: ResolvablePerson): void {
    this.byIdentityKey.set(person.identityKey, person.id);
    for (const email of person.knownEmails) {
      this.byEmail.set(email.trim().toLowerCase(), person.id);
    }
  }

  registerEmail(personId: Uuid, address: string): void {
    this.byEmail.set(address.trim().toLowerCase(), personId);
  }

  resolve(input: {
    stateCode: string;
    orgScopeId: string;
    fullNamePublished: string;
    publishedEmails: readonly string[];
  }): PersonMatch {
    for (const address of input.publishedEmails) {
      const personId = this.byEmail.get(address.trim().toLowerCase());
      if (personId !== undefined) {
        return { personId, strategy: 'published_email', confidence: 0.98 };
      }
    }

    const parsed = parsePersonName(input.fullNamePublished);
    const identityKey = personIdentityKey({
      stateCode: input.stateCode,
      orgScopeId: input.orgScopeId,
      parsed,
    });
    const personId = this.byIdentityKey.get(identityKey);
    if (personId !== undefined) {
      return { personId, strategy: 'identity_key', confidence: parsed.lowConfidence ? 0.6 : 0.85 };
    }

    return { personId: null, strategy: 'none', confidence: 0 };
  }
}

/**
 * Widen a provenance window on re-observation.
 *
 * `firstSeenAt` only ever moves earlier and `lastSeenAt` only ever moves later,
 * so a recrawl records that a record is still present without rewriting when we
 * first found it.
 */
export function mergeProvenance(stored: Provenance, incoming: Provenance): Provenance {
  return {
    ...incoming,
    firstSeenAt: earlier(stored.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: later(stored.lastSeenAt, incoming.lastSeenAt),
    confidence: Math.max(stored.confidence, incoming.confidence),
  };
}

function earlier(a: Timestamp, b: Timestamp): Timestamp {
  return a <= b ? a : b;
}

function later(a: Timestamp, b: Timestamp): Timestamp {
  return a >= b ? a : b;
}
