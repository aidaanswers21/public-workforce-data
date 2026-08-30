import { describe, expect, it } from 'vitest';
import type { SourcePolicyRecord } from '@pan/shared-types';
import { SourcePolicyRegistry, SourcePolicyViolation } from './source-policy.js';

function policy(overrides: Partial<SourcePolicyRecord> & { id: string }): SourcePolicyRecord {
  return {
    domain: null,
    urlPattern: null,
    organizationId: null,
    jurisdictionId: null,
    sourceTypeCode: null,
    collectionStatus: 'unknown',
    commercialUseStatus: 'unknown',
    solicitationStatus: 'unknown',
    automatedAccessStatus: 'unknown',
    policyUrl: null,
    policyTextSnapshot: null,
    policyTextHash: null,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    lastReviewedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    productionApprovedBy: null,
    productionApprovedAt: null,
    productionApprovalNote: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const URL = 'https://agency.example.gov/leadership';

describe('SourcePolicyRegistry, collection gate', () => {
  it('allows a source recorded as permitted', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'p1', domain: 'agency.example.gov', collectionStatus: 'permitted' }),
    ]);
    expect(registry.evaluate(URL).allowed).toBe(true);
  });

  it('refuses a source recorded as prohibited', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'p1', domain: 'agency.example.gov', collectionStatus: 'prohibited' }),
    ]);
    const decision = registry.evaluate(URL);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('prohibited');
  });

  it('does not let an approval override a prohibition', () => {
    const registry = new SourcePolicyRegistry([
      policy({
        id: 'p1',
        domain: 'agency.example.gov',
        collectionStatus: 'prohibited',
        productionApprovedBy: 'someone',
        productionApprovedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    const decision = registry.evaluate(URL);
    expect(decision.allowed).toBe(false);
    expect(decision.unblockableByApproval).toBe(false);
  });

  it('refuses review_required until a person records an approval', () => {
    const pending = new SourcePolicyRegistry([
      policy({ id: 'p1', domain: 'agency.example.gov', collectionStatus: 'review_required' }),
    ]);
    expect(pending.evaluate(URL).allowed).toBe(false);
    expect(pending.evaluate(URL).unblockableByApproval).toBe(true);

    const approved = new SourcePolicyRegistry([
      policy({
        id: 'p1',
        domain: 'agency.example.gov',
        collectionStatus: 'review_required',
        productionApprovedBy: 'compliance@example.org',
        productionApprovedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    expect(approved.evaluate(URL).allowed).toBe(true);
  });

  it('refuses a source with no policy at all by default', () => {
    const decision = SourcePolicyRegistry.empty().evaluate(URL);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('unknown');
    expect(decision.reason).toContain('review');
  });

  it('allows unreviewed sources only when the deployment opts in', () => {
    const registry = new SourcePolicyRegistry([], { allowUnreviewedSources: true });
    expect(registry.evaluate(URL).allowed).toBe(true);
  });

  it('does not gate a fixture run, because nothing is collected', () => {
    expect(SourcePolicyRegistry.empty().evaluate(URL, 'fixture').allowed).toBe(true);
  });

  it('throws when asked to assert on a refused source', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'p1', domain: 'agency.example.gov', collectionStatus: 'prohibited' }),
    ]);
    expect(() => registry.assertCollectable(URL)).toThrow(SourcePolicyViolation);
  });
});

describe('SourcePolicyRegistry, matching', () => {
  it('prefers a url pattern over a domain rule', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'broad', domain: 'agency.example.gov', collectionStatus: 'permitted' }),
      policy({ id: 'narrow', urlPattern: '/leadership', collectionStatus: 'prohibited' }),
    ]);
    expect(registry.evaluate(URL).policyId).toBe('narrow');
    expect(registry.evaluate('https://agency.example.gov/about').policyId).toBe('broad');
  });

  it('prefers an exact domain over a parent domain', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'parent', domain: 'example.gov', collectionStatus: 'permitted' }),
      policy({ id: 'exact', domain: 'agency.example.gov', collectionStatus: 'prohibited' }),
    ]);
    expect(registry.evaluate(URL).policyId).toBe('exact');
  });

  it('applies a parent-domain rule to a subdomain', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'parent', domain: 'example.gov', collectionStatus: 'prohibited' }),
    ]);
    expect(registry.evaluate('https://field.agency.example.gov/staff').allowed).toBe(false);
  });

  it('ignores a malformed stored pattern rather than matching everything', () => {
    const registry = new SourcePolicyRegistry([
      policy({ id: 'broken', urlPattern: '([', collectionStatus: 'prohibited' }),
    ]);
    expect(registry.resolve(URL)).toBeNull();
  });
});

describe('SourcePolicyRegistry, downstream use', () => {
  it('reports use stances separately from collection', () => {
    const registry = new SourcePolicyRegistry([
      policy({
        id: 'p1',
        domain: 'agency.example.gov',
        collectionStatus: 'permitted',
        commercialUseStatus: 'prohibited',
        solicitationStatus: 'prohibited',
        automatedAccessStatus: 'permitted',
      }),
    ]);
    expect(registry.evaluate(URL).allowed).toBe(true);
    expect(registry.useStance(URL, 'commercial').stance).toBe('prohibited');
    expect(registry.useStance(URL, 'solicitation').stance).toBe('prohibited');
    expect(registry.useStance(URL, 'automated_access').stance).toBe('permitted');
  });

  it('reports unknown for a source with no policy', () => {
    expect(SourcePolicyRegistry.empty().useStance(URL, 'commercial').stance).toBe('unknown');
  });
});
