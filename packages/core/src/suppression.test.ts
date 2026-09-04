import { describe, expect, it } from 'vitest';
import type { SuppressionEntryRecord, SuppressionScope } from '@public-workforce/shared-types';
import { OrganizationHierarchy, SuppressionError, SuppressionIndex } from './suppression.js';

const NOW = '2026-06-01T00:00:00.000Z';

function entry(
  overrides: Partial<SuppressionEntryRecord> & { scope: SuppressionScope; value: string },
): SuppressionEntryRecord {
  return {
    id: `entry-${overrides.scope}-${overrides.value}`,
    personId: null,
    organizationId: null,
    jurisdictionId: null,
    geographicAreaId: null,
    sourceDocumentId: null,
    governmentLevelCode: null,
    exportPurpose: null,
    reason: 'opt-out request',
    source: 'opt_out_request',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    createdBy: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SuppressionIndex, address and person scopes', () => {
  it('suppresses an exact address', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'jane@agency.example.gov' }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'Jane@Agency.example.gov' }, NOW)).toBe(true);
    expect(index.isSuppressed({ emailAddress: 'other@agency.example.gov' }, NOW)).toBe(false);
  });

  it('suppresses a whole domain, including subdomains', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'domain', value: 'agency.example.gov' }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'anyone@agency.example.gov' }, NOW)).toBe(true);
    expect(index.isSuppressed({ emailAddress: 'anyone@field.agency.example.gov' }, NOW)).toBe(true);
    expect(index.isSuppressed({ emailAddress: 'anyone@other.example.gov' }, NOW)).toBe(false);
  });

  it('suppresses one person', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'person', value: 'p1', personId: 'p1' }),
    ]);
    expect(index.isSuppressed({ personId: 'p1' }, NOW)).toBe(true);
    expect(index.isSuppressed({ personId: 'p2' }, NOW)).toBe(false);
  });
});

describe('SuppressionIndex, organization scopes', () => {
  /**
   * A federal department with a bureau, a field office under that bureau, and
   * an unrelated county. Built as a graph so the subtree tests exercise the
   * same ancestry logic the database resolves with a recursive query.
   */
  const hierarchy = new OrganizationHierarchy([
    { parentOrganizationId: 'dept', childOrganizationId: 'bureau' },
    { parentOrganizationId: 'bureau', childOrganizationId: 'field-office' },
    { parentOrganizationId: 'bureau', childOrganizationId: 'lab' },
  ]);

  const subjectFor = (
    organizationId: string,
  ): { organizationId: string; organizationAncestorIds: string[] } => ({
    organizationId,
    organizationAncestorIds: hierarchy.ancestorsOf(organizationId),
  });

  it('suppresses exactly one organization under the organization scope', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization', value: 'bureau', organizationId: 'bureau' }),
    ]);
    expect(index.isSuppressed(subjectFor('bureau'), NOW)).toBe(true);
    expect(index.isSuppressed(subjectFor('field-office'), NOW)).toBe(false);
    expect(index.isSuppressed(subjectFor('dept'), NOW)).toBe(false);
  });

  it('suppresses everything beneath an organization under the subtree scope', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization_subtree', value: 'dept', organizationId: 'dept' }),
    ]);
    expect(index.isSuppressed(subjectFor('dept'), NOW)).toBe(true);
    expect(index.isSuppressed(subjectFor('bureau'), NOW)).toBe(true);
    expect(index.isSuppressed(subjectFor('field-office'), NOW)).toBe(true);
    expect(index.isSuppressed(subjectFor('lab'), NOW)).toBe(true);
  });

  it('does not suppress an organization outside the subtree', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization_subtree', value: 'dept', organizationId: 'dept' }),
    ]);
    expect(index.isSuppressed(subjectFor('unrelated-county'), NOW)).toBe(false);
  });

  it('suppresses a mid-level subtree without touching its parent', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization_subtree', value: 'bureau', organizationId: 'bureau' }),
    ]);
    expect(index.isSuppressed(subjectFor('dept'), NOW)).toBe(false);
    expect(index.isSuppressed(subjectFor('bureau'), NOW)).toBe(true);
    expect(index.isSuppressed(subjectFor('field-office'), NOW)).toBe(true);
  });

  it('reports which ancestor caught the record', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization_subtree', value: 'dept', organizationId: 'dept' }),
    ]);
    const decision = index.check(subjectFor('field-office'), NOW);
    expect(decision.matches[0]?.matchedVia).toBe('dept');
  });

  it('does not suppress a subtree when no ancestry is supplied', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'organization_subtree', value: 'dept', organizationId: 'dept' }),
    ]);
    expect(index.isSuppressed({ organizationId: 'field-office' }, NOW)).toBe(false);
  });
});

describe('OrganizationHierarchy', () => {
  it('walks several levels, nearest ancestor first', () => {
    const hierarchy = new OrganizationHierarchy([
      { parentOrganizationId: 'a', childOrganizationId: 'b' },
      { parentOrganizationId: 'b', childOrganizationId: 'c' },
      { parentOrganizationId: 'c', childOrganizationId: 'd' },
    ]);
    expect(hierarchy.ancestorsOf('d')).toEqual(['c', 'b', 'a']);
    expect(hierarchy.selfAndAncestors('d')).toEqual(['d', 'c', 'b', 'a']);
  });

  it('supports an organization with more than one parent', () => {
    const hierarchy = new OrganizationHierarchy([
      { parentOrganizationId: 'county', childOrganizationId: 'joint-authority' },
      { parentOrganizationId: 'city', childOrganizationId: 'joint-authority' },
    ]);
    expect(hierarchy.ancestorsOf('joint-authority').sort()).toEqual(['city', 'county']);
  });

  it('survives a cycle rather than hanging', () => {
    const hierarchy = new OrganizationHierarchy([
      { parentOrganizationId: 'a', childOrganizationId: 'b' },
      { parentOrganizationId: 'b', childOrganizationId: 'a' },
    ]);
    expect(hierarchy.ancestorsOf('a')).toEqual(['b']);
  });

  it('returns nothing for an organization with no parent, as a federal body has none', () => {
    expect(new OrganizationHierarchy().ancestorsOf('independent-agency')).toEqual([]);
  });
});

describe('SuppressionIndex, jurisdiction and geography scopes', () => {
  it('suppresses by jurisdiction', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'jurisdiction', value: 'j1', jurisdictionId: 'j1' }),
    ]);
    expect(index.isSuppressed({ jurisdictionId: 'j1' }, NOW)).toBe(true);
    expect(index.isSuppressed({ jurisdictionId: 'j2' }, NOW)).toBe(false);
  });

  it('suppresses an entire level of government', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'government_level', value: 'federal', governmentLevelCode: 'federal' }),
    ]);
    expect(index.isSuppressed({ governmentLevelCode: 'federal' }, NOW)).toBe(true);
    expect(index.isSuppressed({ governmentLevelCode: 'county' }, NOW)).toBe(false);
  });

  it('suppresses by geographic area, matching any area the record sits in', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'geographic_area', value: 'area-tx', geographicAreaId: 'area-tx' }),
    ]);
    expect(index.isSuppressed({ geographicAreaIds: ['area-harris', 'area-tx'] }, NOW)).toBe(true);
    expect(index.isSuppressed({ geographicAreaIds: ['area-ca'] }, NOW)).toBe(false);
  });

  it('suppresses an entire source', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'source', value: 'doc-1', sourceDocumentId: 'doc-1' }),
    ]);
    expect(index.isSuppressed({ sourceDocumentId: 'doc-1' }, NOW)).toBe(true);
    expect(index.isSuppressed({ sourceDocumentId: 'doc-2' }, NOW)).toBe(false);
  });

  it('suppresses one declared use without suppressing the record everywhere', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'export_purpose', value: 'outreach', exportPurpose: 'outreach' }),
    ]);
    expect(index.isSuppressed({ personId: 'p1', exportPurpose: 'outreach' }, NOW)).toBe(true);
    expect(index.isSuppressed({ personId: 'p1', exportPurpose: 'internal-review' }, NOW)).toBe(
      false,
    );
  });

  it('suppresses everything under a global entry', () => {
    const index = SuppressionIndex.fromEntries([entry({ scope: 'global', value: '*' })]);
    expect(index.isSuppressed({ emailAddress: 'anyone@anywhere.example.gov' }, NOW)).toBe(true);
    expect(index.isSuppressed({ organizationId: 'anything' }, NOW)).toBe(true);
  });
});

describe('SuppressionIndex, lifecycle', () => {
  it('honours effective and expiry dates', () => {
    const index = SuppressionIndex.fromEntries([
      entry({
        scope: 'email',
        value: 'jane@agency.example.gov',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    ]);
    expect(
      index.isSuppressed({ emailAddress: 'jane@agency.example.gov' }, '2026-04-01T00:00:00.000Z'),
    ).toBe(false);
    expect(index.isSuppressed({ emailAddress: 'jane@agency.example.gov' }, NOW)).toBe(true);
    expect(
      index.isSuppressed({ emailAddress: 'jane@agency.example.gov' }, '2026-08-01T00:00:00.000Z'),
    ).toBe(false);
  });

  it('ignores revoked entries', () => {
    const index = SuppressionIndex.fromEntries([
      entry({
        scope: 'email',
        value: 'jane@agency.example.gov',
        revokedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'jane@agency.example.gov' }, NOW)).toBe(false);
  });

  it('reports the most specific matching scope first', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'global', value: '*' }),
      entry({ scope: 'email', value: 'jane@agency.example.gov' }),
      entry({ scope: 'domain', value: 'agency.example.gov' }),
      entry({ scope: 'organization', value: 'org-1', organizationId: 'org-1' }),
    ]);
    const decision = index.check(
      { emailAddress: 'jane@agency.example.gov', organizationId: 'org-1' },
      NOW,
    );
    expect(decision.matches.map((match) => match.scope)).toEqual([
      'email',
      'organization',
      'domain',
      'global',
    ]);
  });

  it('throws with the matching entry when asserting', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'jane@agency.example.gov' }),
    ]);
    expect(() =>
      index.assertNotSuppressed({ emailAddress: 'jane@agency.example.gov' }, NOW),
    ).toThrow(SuppressionError);
    expect(() =>
      index.assertNotSuppressed({ emailAddress: 'other@agency.example.gov' }, NOW),
    ).not.toThrow();
  });

  it('partitions a list without losing the suppressed side', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'b@x.example.gov' }),
    ]);
    const rows = [
      { email: 'a@x.example.gov' },
      { email: 'b@x.example.gov' },
      { email: 'c@x.example.gov' },
    ];
    const result = index.partition(rows, (row) => ({ emailAddress: row.email }), NOW);
    expect(result.allowed).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.decision.matches[0]?.scope).toBe('email');
  });

  it('an empty index suppresses nothing', () => {
    expect(SuppressionIndex.empty().isSuppressed({ emailAddress: 'a@x.example.gov' }, NOW)).toBe(
      false,
    );
  });
});
