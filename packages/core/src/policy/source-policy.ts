import type { CollectionStatus, SourcePolicyRecord, Uuid } from '@pan/shared-types';
import { domainOf, registrableDomain } from '../normalize/urls.js';

export type CollectionMode = 'production' | 'fixture';

export interface SourcePolicyDecision {
  allowed: boolean;
  status: CollectionStatus;
  policyId: Uuid | null;
  /** Why the crawler may or may not proceed, in words an operator can act on. */
  reason: string;
  /** True when a person could unblock this by recording an approval. */
  unblockableByApproval: boolean;
}

export interface SourcePolicyOptions {
  /**
   * Whether to collect from a source no policy covers.
   *
   * Defaults to false. A source nobody has reviewed is not the same as a source
   * someone approved, and defaulting open would make the whole registry
   * advisory. Turn it on deliberately, per deployment, and record why.
   */
  allowUnreviewedSources?: boolean;
  /**
   * DNS labels that make a US locality domain, from the taxonomy.
   *
   * Without them `co.harris.tx.us` collapses to `tx.us`, and a policy row about
   * one county would quietly cover every public body in the state.
   */
  localityDomainLabels?: readonly string[];
}

export class SourcePolicyViolation extends Error {
  constructor(
    readonly url: string,
    readonly decision: SourcePolicyDecision,
  ) {
    super(`source policy refuses collection from ${url}: ${decision.reason}`);
    this.name = 'SourcePolicyViolation';
  }
}

/**
 * Decides whether the crawler may collect from a URL.
 *
 * The rules are deliberately blunt, because the failure mode is collecting from
 * somewhere we were told not to:
 *
 * - `prohibited` is absolute. A recorded approval does not override it; if the
 *   policy was read wrongly, the fix is to correct the policy row, which leaves
 *   an audit trail, not to wave the crawler through.
 * - `review_required` blocks until a person records an approval on the row.
 * - `unknown`, and no policy at all, block unless the deployment has explicitly
 *   opted into collecting from unreviewed sources.
 * - `permitted` allows collection.
 *
 * A vendor's assurance that data is compliant changes none of these fields.
 * Only a recorded human review does.
 */
export class SourcePolicyRegistry {
  private readonly policies: readonly SourcePolicyRecord[];

  constructor(
    policies: readonly SourcePolicyRecord[] = [],
    private readonly options: SourcePolicyOptions = {},
  ) {
    this.policies = policies;
  }

  static empty(): SourcePolicyRegistry {
    return new SourcePolicyRegistry([]);
  }

  /**
   * The most specific policy covering a URL.
   *
   * A URL pattern beats a domain, and an exact domain beats a registrable
   * parent, so a narrow rule about one path is never masked by a broad one
   * about the whole site.
   */
  resolve(url: string): SourcePolicyRecord | null {
    const host = domainOf(url);
    if (host === null) return null;
    const root = registrableDomain(host, this.options.localityDomainLabels ?? []);

    const scored = this.policies
      .map((policy) => ({ policy, score: this.matchScore(policy, url, host, root) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.policy ?? null;
  }

  private matchScore(policy: SourcePolicyRecord, url: string, host: string, root: string): number {
    if (policy.urlPattern !== null && policy.urlPattern.length > 0) {
      try {
        if (new RegExp(policy.urlPattern, 'i').test(url)) return 3;
      } catch {
        // A malformed stored pattern must not silently match everything.
        return 0;
      }
      return 0;
    }
    if (policy.domain === null || policy.domain.length === 0) return 0;
    const policyDomain = policy.domain.toLowerCase().replace(/^www\./, '');
    if (policyDomain === host) return 2;
    if (host.endsWith(`.${policyDomain}`) || policyDomain === root) return 1;
    return 0;
  }

  evaluate(url: string, mode: CollectionMode = 'production'): SourcePolicyDecision {
    // Fixture runs read saved files. Nothing is collected, so nothing is gated.
    if (mode === 'fixture') {
      return {
        allowed: true,
        status: 'permitted',
        policyId: null,
        reason: 'fixture run: no collection takes place',
        unblockableByApproval: false,
      };
    }

    const policy = this.resolve(url);

    if (policy === null) {
      const allowed = this.options.allowUnreviewedSources === true;
      return {
        allowed,
        status: 'unknown',
        policyId: null,
        reason: allowed
          ? 'no policy on record; deployment permits unreviewed sources'
          : 'no source policy on record; a person must review this source before production collection',
        unblockableByApproval: true,
      };
    }

    if (policy.collectionStatus === 'prohibited') {
      return {
        allowed: false,
        status: 'prohibited',
        policyId: policy.id,
        reason: `collection is prohibited by the recorded policy${policy.policyUrl === null ? '' : ` (${policy.policyUrl})`}`,
        unblockableByApproval: false,
      };
    }

    if (policy.collectionStatus === 'review_required' || policy.collectionStatus === 'unknown') {
      const approved = policy.productionApprovedBy !== null && policy.productionApprovedAt !== null;
      if (approved) {
        return {
          allowed: true,
          status: policy.collectionStatus,
          policyId: policy.id,
          reason: `approved for production by ${policy.productionApprovedBy ?? 'unknown'} on ${policy.productionApprovedAt ?? 'unknown'}`,
          unblockableByApproval: false,
        };
      }
      if (policy.collectionStatus === 'unknown' && this.options.allowUnreviewedSources === true) {
        return {
          allowed: true,
          status: 'unknown',
          policyId: policy.id,
          reason: 'policy status is unknown; deployment permits unreviewed sources',
          unblockableByApproval: true,
        };
      }
      return {
        allowed: false,
        status: policy.collectionStatus,
        policyId: policy.id,
        reason:
          policy.collectionStatus === 'review_required'
            ? 'policy requires human review; no production approval is recorded on the policy row'
            : 'policy status is unknown; no production approval is recorded on the policy row',
        unblockableByApproval: true,
      };
    }

    return {
      allowed: true,
      status: 'permitted',
      policyId: policy.id,
      reason: 'collection is permitted by the recorded policy',
      unblockableByApproval: false,
    };
  }

  /** Throws rather than returning. Used where proceeding would be a policy breach. */
  assertCollectable(url: string, mode: CollectionMode = 'production'): SourcePolicyDecision {
    const decision = this.evaluate(url, mode);
    if (!decision.allowed) throw new SourcePolicyViolation(url, decision);
    return decision;
  }

  /**
   * Whether a downstream use is permitted by the policy covering a URL.
   *
   * Separate from collection on purpose: a source may allow reading and forbid
   * commercial use or solicitation, and conflating the two is how a lawful
   * collection becomes an unlawful use.
   */
  useStance(
    url: string,
    use: 'commercial' | 'solicitation' | 'automated_access',
  ): { stance: SourcePolicyRecord['commercialUseStatus']; policyId: Uuid | null } {
    const policy = this.resolve(url);
    if (policy === null) return { stance: 'unknown', policyId: null };
    const stance =
      use === 'commercial'
        ? policy.commercialUseStatus
        : use === 'solicitation'
          ? policy.solicitationStatus
          : policy.automatedAccessStatus;
    return { stance, policyId: policy.id };
  }
}
