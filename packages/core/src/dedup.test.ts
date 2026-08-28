import { describe, expect, it } from 'vitest';
import type { ExtractedPersonRecord, Provenance } from '@pan/shared-types';
import { PersonResolver, dedupeExtractedRecords, mergeProvenance } from './dedup.js';

function record(
  overrides: Partial<ExtractedPersonRecord> & { recordKey: string; fullNamePublished: string },
): ExtractedPersonRecord {
  return {
    titlePublished: null,
    departmentPublished: null,
    schoolPublished: null,
    phonePublished: null,
    emails: [],
    profileUrl: null,
    extractionMethod: 'html_table',
    confidence: 0.8,
    selector: null,
    snippet: null,
    ...overrides,
  };
}

const email = (address: string) => ({
  raw: address,
  address,
  obfuscation: 'none' as const,
  looksLikeGeneralInbox: false,
});

describe('dedupeExtractedRecords', () => {
  it('collapses records that share a record key', () => {
    const result = dedupeExtractedRecords([
      record({ recordKey: 'k1', fullNamePublished: 'Jane Smith' }),
      record({ recordKey: 'k1', fullNamePublished: 'Jane Smith' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('unions emails when merging duplicates', () => {
    const result = dedupeExtractedRecords([
      record({
        recordKey: 'k1',
        fullNamePublished: 'Jane Smith',
        emails: [email('a@x.example.org')],
      }),
      record({
        recordKey: 'k1',
        fullNamePublished: 'Jane Smith',
        emails: [email('b@x.example.org')],
      }),
    ]);
    expect(result[0]?.emails.map((e) => e.address).sort()).toEqual([
      'a@x.example.org',
      'b@x.example.org',
    ]);
  });

  it('merges the same person listed twice on one page under different keys', () => {
    const result = dedupeExtractedRecords([
      record({
        recordKey: 'k1',
        fullNamePublished: 'Jane Smith',
        titlePublished: 'Math Teacher',
        confidence: 0.9,
      }),
      record({
        recordKey: 'k2',
        fullNamePublished: 'Jane Smith',
        titlePublished: 'Math Teacher',
        confidence: 0.5,
        emails: [email('jane@x.example.org')],
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe(0.9);
    expect(result[0]?.emails).toHaveLength(1);
  });

  it('keeps two different people with the same title apart', () => {
    const result = dedupeExtractedRecords([
      record({ recordKey: 'k1', fullNamePublished: 'Jane Smith', titlePublished: 'Math Teacher' }),
      record({ recordKey: 'k2', fullNamePublished: 'Wei Chen', titlePublished: 'Math Teacher' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('keeps one name at two schools apart', () => {
    const result = dedupeExtractedRecords([
      record({
        recordKey: 'k1',
        fullNamePublished: 'Jane Smith',
        titlePublished: 'Teacher',
        schoolPublished: 'North Elementary',
      }),
      record({
        recordKey: 'k2',
        fullNamePublished: 'Jane Smith',
        titlePublished: 'Teacher',
        schoolPublished: 'South Elementary',
      }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe('PersonResolver', () => {
  const base = { stateCode: 'TX', orgScopeId: 'district-1' };

  it('matches on a published email before anything else', () => {
    const resolver = new PersonResolver([
      { id: 'p1', identityKey: 'tx|district-1|smith-jane', knownEmails: ['jsmith@x.example.org'] },
    ]);
    const match = resolver.resolve({
      ...base,
      fullNamePublished: 'J. Smith',
      publishedEmails: ['jsmith@x.example.org'],
    });
    expect(match).toMatchObject({ personId: 'p1', strategy: 'published_email' });
  });

  it('falls back to the identity key within one organization', () => {
    const resolver = new PersonResolver([
      { id: 'p1', identityKey: 'tx|district-1|smith-jane', knownEmails: [] },
    ]);
    const match = resolver.resolve({
      ...base,
      fullNamePublished: 'Jane M. Smith',
      publishedEmails: [],
    });
    expect(match).toMatchObject({ personId: 'p1', strategy: 'identity_key' });
  });

  it('does not match the same name in a different organization', () => {
    const resolver = new PersonResolver([
      { id: 'p1', identityKey: 'tx|district-1|smith-jane', knownEmails: [] },
    ]);
    const match = resolver.resolve({
      stateCode: 'TX',
      orgScopeId: 'district-2',
      fullNamePublished: 'Jane Smith',
      publishedEmails: [],
    });
    expect(match).toMatchObject({ personId: null, strategy: 'none' });
  });

  it('lowers confidence for an unsplittable name', () => {
    const resolver = new PersonResolver([
      { id: 'p1', identityKey: 'tx|district-1|prince', knownEmails: [] },
    ]);
    const match = resolver.resolve({ ...base, fullNamePublished: 'Prince', publishedEmails: [] });
    expect(match.confidence).toBeLessThan(0.8);
  });
});

describe('mergeProvenance', () => {
  const provenance = (firstSeenAt: string, lastSeenAt: string, confidence = 0.5): Provenance => ({
    sourcePageId: 'page-1',
    inferenceEvidenceId: null,
    crawlRunId: 'run-1',
    extractionMethod: 'html_table',
    confidence,
    firstSeenAt,
    lastSeenAt,
  });

  it('widens the window rather than overwriting it', () => {
    const merged = mergeProvenance(
      provenance('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      provenance('2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
    );
    expect(merged.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.lastSeenAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('keeps the higher confidence', () => {
    const merged = mergeProvenance(
      provenance('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0.9),
      provenance('2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 0.4),
    );
    expect(merged.confidence).toBe(0.9);
  });
});
