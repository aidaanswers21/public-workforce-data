import type { SuppressionEntryRecord, SuppressionScope, Timestamp, Uuid } from '@pan/shared-types';
import { isEffectiveAt } from './time.js';

/**
 * The identifying facts a record is checked against.
 *
 * `organizationAncestorIds` is supplied by the caller because computing it
 * requires the relationship graph, which the index does not own. The database
 * resolves it with a recursive query; tests and in-memory callers use
 * `OrganizationHierarchy` below. Getting only one of those right is the likeliest
 * way subtree suppression silently fails, so both are tested.
 */
export interface SuppressionSubject {
  emailAddress?: string | null;
  personId?: Uuid | null;
  organizationId?: Uuid | null;
  /** Every organization above this one, nearest first. */
  organizationAncestorIds?: readonly Uuid[];
  jurisdictionId?: Uuid | null;
  governmentLevelCode?: string | null;
  /** Areas this record sits in: a duty location may be in a county and a state. */
  geographicAreaIds?: readonly Uuid[];
  sourceDocumentId?: Uuid | null;
  /** The declared purpose of the export asking for this record. */
  exportPurpose?: string | null;
}

export interface SuppressionMatch {
  entryId: Uuid;
  scope: SuppressionScope;
  value: string;
  reason: string;
  effectiveAt: Timestamp;
  expiresAt: Timestamp | null;
  /** For a subtree match, the organization whose suppression caught this record. */
  matchedVia: string | null;
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
  'organization',
  'organization_subtree',
  'domain',
  'source',
  'jurisdiction',
  'geographic_area',
  'government_level',
  'export_purpose',
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
 * Resolves the organizations above a given one.
 *
 * Only relationships that imply containment count, which the taxonomy marks
 * with `impliesSubtree`. Oversight and succession do not roll suppression down:
 * a body that once succeeded another should not inherit its opt-outs.
 */
export class OrganizationHierarchy {
  private readonly parentsByChild = new Map<Uuid, Set<Uuid>>();

  constructor(edges: readonly { parentOrganizationId: Uuid; childOrganizationId: Uuid }[] = []) {
    for (const edge of edges) this.addEdge(edge.parentOrganizationId, edge.childOrganizationId);
  }

  addEdge(parentOrganizationId: Uuid, childOrganizationId: Uuid): void {
    const parents = this.parentsByChild.get(childOrganizationId);
    if (parents === undefined)
      this.parentsByChild.set(childOrganizationId, new Set([parentOrganizationId]));
    else parents.add(parentOrganizationId);
  }

  /**
   * Every ancestor, breadth first, nearest first.
   *
   * Cycles are survivable rather than fatal: public-sector data occasionally
   * describes one, and refusing to answer would suppress nothing at all.
   */
  ancestorsOf(organizationId: Uuid): Uuid[] {
    const seen = new Set<Uuid>([organizationId]);
    const ordered: Uuid[] = [];
    let frontier: Uuid[] = [organizationId];

    while (frontier.length > 0) {
      const next: Uuid[] = [];
      for (const current of frontier) {
        for (const parent of this.parentsByChild.get(current) ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          ordered.push(parent);
          next.push(parent);
        }
      }
      frontier = next;
    }
    return ordered;
  }

  /** The organization plus every ancestor. What a subtree check reads. */
  selfAndAncestors(organizationId: Uuid): Uuid[] {
    return [organizationId, ...this.ancestorsOf(organizationId)];
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
  private readonly byOrganization = new Map<string, SuppressionEntryRecord[]>();
  private readonly byOrganizationSubtree = new Map<string, SuppressionEntryRecord[]>();
  private readonly byJurisdiction = new Map<string, SuppressionEntryRecord[]>();
  private readonly byGovernmentLevel = new Map<string, SuppressionEntryRecord[]>();
  private readonly byGeographicArea = new Map<string, SuppressionEntryRecord[]>();
  private readonly bySource = new Map<string, SuppressionEntryRecord[]>();
  private readonly byExportPurpose = new Map<string, SuppressionEntryRecord[]>();
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
        case 'organization':
          push(this.byOrganization, entry.organizationId ?? value, entry);
          break;
        case 'organization_subtree':
          push(this.byOrganizationSubtree, entry.organizationId ?? value, entry);
          break;
        case 'jurisdiction':
          push(this.byJurisdiction, entry.jurisdictionId ?? value, entry);
          break;
        case 'government_level':
          push(this.byGovernmentLevel, entry.governmentLevelCode ?? value, entry);
          break;
        case 'geographic_area':
          push(this.byGeographicArea, entry.geographicAreaId ?? value, entry);
          break;
        case 'source':
          push(this.bySource, entry.sourceDocumentId ?? value, entry);
          break;
        case 'export_purpose':
          push(this.byExportPurpose, entry.exportPurpose ?? value, entry);
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
   * Domain matching covers subdomains, so suppressing `agency.gov` also
   * suppresses `regionaloffice.agency.gov`. An organization opt-out should not
   * be defeated by a mail subdomain, and a subtree opt-out should not be
   * defeated by a subordinate office having its own site.
   */
  check(subject: SuppressionSubject, at: Timestamp): SuppressionDecision {
    const matches: SuppressionMatch[] = [];
    const consider = (
      candidates: readonly SuppressionEntryRecord[] | undefined,
      matchedVia: string | null = null,
    ): void => {
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
          matchedVia,
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
          if (domain.endsWith(`.${suppressedDomain}`)) consider(entries, suppressedDomain);
        }
      }
    }

    if (subject.personId) consider(this.byPerson.get(subject.personId));
    if (subject.organizationId) consider(this.byOrganization.get(subject.organizationId));

    // Subtree entries match the organization itself and everything above it.
    if (this.byOrganizationSubtree.size > 0 && subject.organizationId) {
      const chain = [subject.organizationId, ...(subject.organizationAncestorIds ?? [])];
      for (const organizationId of chain) {
        consider(
          this.byOrganizationSubtree.get(organizationId),
          organizationId === subject.organizationId ? null : organizationId,
        );
      }
    }

    if (subject.jurisdictionId) consider(this.byJurisdiction.get(subject.jurisdictionId));
    if (subject.governmentLevelCode)
      consider(this.byGovernmentLevel.get(subject.governmentLevelCode));
    for (const areaId of subject.geographicAreaIds ?? [])
      consider(this.byGeographicArea.get(areaId));
    if (subject.sourceDocumentId) consider(this.bySource.get(subject.sourceDocumentId));
    if (subject.exportPurpose) consider(this.byExportPurpose.get(subject.exportPurpose));
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
      this.byOrganization.size +
      this.byOrganizationSubtree.size +
      this.byJurisdiction.size +
      this.byGovernmentLevel.size +
      this.byGeographicArea.size +
      this.bySource.size +
      this.byExportPurpose.size +
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
