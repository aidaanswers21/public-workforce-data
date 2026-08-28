import type { SuppressionEntryRecord, SuppressionScope, Timestamp, Uuid } from '@pan/shared-types';
import { isEffectiveAt } from './time.js';

/** The identifying facts about a record that suppression is checked against. */
export interface SuppressionSubject {
  emailAddress?: string | null;
  personId?: Uuid | null;
  schoolId?: Uuid | null;
  districtId?: Uuid | null;
  stateId?: Uuid | null;
}

export interface SuppressionMatch {
  entryId: Uuid;
  scope: SuppressionScope;
  value: string;
  reason: string;
  effectiveAt: Timestamp;
  expiresAt: Timestamp | null;
}

export interface SuppressionDecision {
  suppressed: boolean;
  /** Every matching entry, most specific scope first. Empty when not suppressed. */
  matches: readonly SuppressionMatch[];
}

/** Most specific first, so the reported reason is the most meaningful one. */
const SCOPE_SPECIFICITY: readonly SuppressionScope[] = [
  'email',
  'person',
  'domain',
  'school',
  'district',
  'state',
  'global',
];

export class SuppressionError extends Error {
  constructor(
    message: string,
    readonly decision: SuppressionDecision,
    readonly subject: SuppressionSubject,
  ) {
    super(message);
    this.name = 'SuppressionError';
  }
}

/**
 * In-memory index over active suppression entries.
 *
 * Built once per query or export and consulted for every record. Entries are
 * never mutated: a revoked entry carries `revokedAt` and is skipped at load
 * time, which keeps the underlying table an immutable audit trail.
 */
export class SuppressionIndex {
  private readonly byEmail = new Map<string, SuppressionEntryRecord[]>();
  private readonly byDomain = new Map<string, SuppressionEntryRecord[]>();
  private readonly byPerson = new Map<string, SuppressionEntryRecord[]>();
  private readonly bySchool = new Map<string, SuppressionEntryRecord[]>();
  private readonly byDistrict = new Map<string, SuppressionEntryRecord[]>();
  private readonly byState = new Map<string, SuppressionEntryRecord[]>();
  private readonly global: SuppressionEntryRecord[] = [];

  private constructor(entries: readonly SuppressionEntryRecord[]) {
    for (const entry of entries) {
      if (entry.revokedAt !== null) continue;
      const value = entry.value.trim().toLowerCase();
      switch (entry.scope) {
        case 'email':
          push(this.byEmail, value, entry);
          break;
        case 'domain':
          push(this.byDomain, value.replace(/^@/, ''), entry);
          break;
        case 'person':
          push(this.byPerson, entry.personId ?? value, entry);
          break;
        case 'school':
          push(this.bySchool, entry.schoolId ?? value, entry);
          break;
        case 'district':
          push(this.byDistrict, entry.districtId ?? value, entry);
          break;
        case 'state':
          push(this.byState, entry.stateId ?? value, entry);
          break;
        case 'global':
          this.global.push(entry);
          break;
      }
    }
  }

  static fromEntries(entries: readonly SuppressionEntryRecord[]): SuppressionIndex {
    return new SuppressionIndex(entries);
  }

  static empty(): SuppressionIndex {
    return new SuppressionIndex([]);
  }

  /**
   * Evaluate every scope against one record.
   *
   * Domain matching covers subdomains, so suppressing `district.org` also
   * suppresses `staff.district.org`. That is intentional: an opt-out at the
   * organization level should not be defeated by a mail subdomain.
   */
  check(subject: SuppressionSubject, at: Timestamp): SuppressionDecision {
    const matches: SuppressionMatch[] = [];
    const consider = (candidates: readonly SuppressionEntryRecord[] | undefined): void => {
      if (candidates === undefined) return;
      for (const entry of candidates) {
        if (!isEffectiveAt(at, entry.effectiveAt, entry.expiresAt)) continue;
        matches.push({
          entryId: entry.id,
          scope: entry.scope,
          value: entry.value,
          reason: entry.reason,
          effectiveAt: entry.effectiveAt,
          expiresAt: entry.expiresAt,
        });
      }
    };

    const email = subject.emailAddress?.trim().toLowerCase() ?? null;
    if (email !== null && email.length > 0) {
      consider(this.byEmail.get(email));
      const domain = email.split('@')[1] ?? '';
      if (domain.length > 0) {
        consider(this.byDomain.get(domain));
        for (const [suppressedDomain, entries] of this.byDomain) {
          if (domain.endsWith(`.${suppressedDomain}`)) consider(entries);
        }
      }
    }
    if (subject.personId) consider(this.byPerson.get(subject.personId));
    if (subject.schoolId) consider(this.bySchool.get(subject.schoolId));
    if (subject.districtId) consider(this.byDistrict.get(subject.districtId));
    if (subject.stateId) consider(this.byState.get(subject.stateId));
    consider(this.global);

    matches.sort((a, b) => SCOPE_SPECIFICITY.indexOf(a.scope) - SCOPE_SPECIFICITY.indexOf(b.scope));
    return { suppressed: matches.length > 0, matches };
  }

  isSuppressed(subject: SuppressionSubject, at: Timestamp): boolean {
    return this.check(subject, at).suppressed;
  }

  /** Throws rather than returning. Used on the export path, where silence is unsafe. */
  assertNotSuppressed(subject: SuppressionSubject, at: Timestamp): void {
    const decision = this.check(subject, at);
    if (decision.suppressed) {
      const first = decision.matches[0];
      throw new SuppressionError(
        `record is suppressed by ${first?.scope ?? 'unknown'} entry ${first?.entryId ?? 'unknown'}`,
        decision,
        subject,
      );
    }
  }

  /** Partition a list, keeping the suppressed side for reporting and audit. */
  partition<T>(
    items: readonly T[],
    toSubject: (item: T) => SuppressionSubject,
    at: Timestamp,
  ): { allowed: T[]; suppressed: { item: T; decision: SuppressionDecision }[] } {
    const allowed: T[] = [];
    const suppressed: { item: T; decision: SuppressionDecision }[] = [];
    for (const item of items) {
      const decision = this.check(toSubject(item), at);
      if (decision.suppressed) suppressed.push({ item, decision });
      else allowed.push(item);
    }
    return { allowed, suppressed };
  }

  get size(): number {
    return (
      this.byEmail.size +
      this.byDomain.size +
      this.byPerson.size +
      this.bySchool.size +
      this.byDistrict.size +
      this.byState.size +
      this.global.length
    );
  }
}

function push(
  map: Map<string, SuppressionEntryRecord[]>,
  key: string,
  entry: SuppressionEntryRecord,
): void {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}
