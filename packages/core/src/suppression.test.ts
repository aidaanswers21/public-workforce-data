import { describe, expect, it } from 'vitest';
import type { SuppressionEntryRecord, SuppressionScope } from '@pan/shared-types';
import { SuppressionError, SuppressionIndex } from './suppression.js';

const NOW = '2026-06-01T00:00:00.000Z';

function entry(
  overrides: Partial<SuppressionEntryRecord> & { scope: SuppressionScope; value: string },
): SuppressionEntryRecord {
  return {
    id: `entry-${overrides.scope}-${overrides.value}`,
    personId: null,
    schoolId: null,
    districtId: null,
    stateId: null,
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

describe('SuppressionIndex', () => {
  it('suppresses an exact address', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'jane@sample-isd.example.org' }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'Jane@Sample-ISD.example.org' }, NOW)).toBe(true);
    expect(index.isSuppressed({ emailAddress: 'other@sample-isd.example.org' }, NOW)).toBe(false);
  });

  it('suppresses a whole domain, including subdomains', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'domain', value: 'sample-isd.example.org' }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'anyone@sample-isd.example.org' }, NOW)).toBe(true);
    expect(index.isSuppressed({ emailAddress: 'anyone@staff.sample-isd.example.org' }, NOW)).toBe(
      true,
    );
    expect(index.isSuppressed({ emailAddress: 'anyone@other-isd.example.org' }, NOW)).toBe(false);
  });

  it.each<
    [
      SuppressionScope,
      keyof { personId: string; schoolId: string; districtId: string; stateId: string },
    ]
  >([
    ['person', 'personId'],
    ['school', 'schoolId'],
    ['district', 'districtId'],
    ['state', 'stateId'],
  ])('suppresses by %s scope', (scope, field) => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope, value: 'target-id', [field]: 'target-id' }),
    ]);
    expect(index.isSuppressed({ [field]: 'target-id' }, NOW)).toBe(true);
    expect(index.isSuppressed({ [field]: 'other-id' }, NOW)).toBe(false);
  });

  it('suppresses everything under a global entry', () => {
    const index = SuppressionIndex.fromEntries([entry({ scope: 'global', value: '*' })]);
    expect(index.isSuppressed({ emailAddress: 'anyone@anywhere.example.org' }, NOW)).toBe(true);
    expect(index.isSuppressed({ personId: 'someone' }, NOW)).toBe(true);
  });

  it('honours effective and expiry dates', () => {
    const index = SuppressionIndex.fromEntries([
      entry({
        scope: 'email',
        value: 'jane@x.example.org',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    ]);
    expect(
      index.isSuppressed({ emailAddress: 'jane@x.example.org' }, '2026-04-01T00:00:00.000Z'),
    ).toBe(false);
    expect(index.isSuppressed({ emailAddress: 'jane@x.example.org' }, NOW)).toBe(true);
    expect(
      index.isSuppressed({ emailAddress: 'jane@x.example.org' }, '2026-08-01T00:00:00.000Z'),
    ).toBe(false);
  });

  it('ignores revoked entries', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'jane@x.example.org', revokedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    expect(index.isSuppressed({ emailAddress: 'jane@x.example.org' }, NOW)).toBe(false);
  });

  it('reports the most specific matching scope first', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'global', value: '*' }),
      entry({ scope: 'email', value: 'jane@x.example.org' }),
      entry({ scope: 'domain', value: 'x.example.org' }),
    ]);
    const decision = index.check({ emailAddress: 'jane@x.example.org' }, NOW);
    expect(decision.matches.map((match) => match.scope)).toEqual(['email', 'domain', 'global']);
  });

  it('throws with the matching entry when asserting', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'jane@x.example.org' }),
    ]);
    expect(() => index.assertNotSuppressed({ emailAddress: 'jane@x.example.org' }, NOW)).toThrow(
      SuppressionError,
    );
    expect(() =>
      index.assertNotSuppressed({ emailAddress: 'other@x.example.org' }, NOW),
    ).not.toThrow();
  });

  it('partitions a list without losing the suppressed side', () => {
    const index = SuppressionIndex.fromEntries([
      entry({ scope: 'email', value: 'b@x.example.org' }),
    ]);
    const rows = [
      { email: 'a@x.example.org' },
      { email: 'b@x.example.org' },
      { email: 'c@x.example.org' },
    ];
    const result = index.partition(rows, (row) => ({ emailAddress: row.email }), NOW);
    expect(result.allowed).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.decision.matches[0]?.scope).toBe('email');
  });

  it('an empty index suppresses nothing', () => {
    expect(SuppressionIndex.empty().isSuppressed({ emailAddress: 'a@x.example.org' }, NOW)).toBe(
      false,
    );
  });
});
