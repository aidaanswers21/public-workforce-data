import { describe, expect, it } from 'vitest';
import type { SuppressionEntryRecord } from '@pan/shared-types';
import { SuppressionIndex, SuppressionError } from '../suppression.js';
import { csvEscape, renderCsv } from './csv.js';
import {
  PEOPLE_EXPORT_COLUMNS,
  exportPeopleCsv,
  type ExportablePersonRow,
} from './people-export.js';

const NOW = '2026-06-01T00:00:00.000Z';

function row(overrides: Partial<ExportablePersonRow> & { personId: string }): ExportablePersonRow {
  return {
    firstName: 'Jane',
    middleName: null,
    lastName: 'Smith',
    fullNamePublished: 'Jane Smith',
    titlePublished: 'Math Teacher',
    titleNormalized: 'Math Teacher',
    roleCategory: 'teacher',
    department: null,
    schoolName: 'Sample High School',
    districtName: 'Sample ISD',
    countyName: 'Harris',
    stateCode: 'TX',
    publishedEmail: `${overrides.personId}@sample-isd.example.org`,
    inferredEmailCandidate: null,
    emailClassification: 'published',
    emailValidationStatus: 'unvalidated',
    inferenceConfidence: null,
    sourceUrl: 'https://sample-isd.example.org/staff-directory',
    sourceType: 'district_site',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: NOW,
    crawlRunId: 'run-1',
    extractionMethod: 'html_table',
    confidence: 0.9,
    status: 'active',
    schoolId: 'school-1',
    districtId: 'district-1',
    stateId: 'state-tx',
    ...overrides,
  };
}

function suppress(
  overrides: Partial<SuppressionEntryRecord> & {
    scope: SuppressionEntryRecord['scope'];
    value: string;
  },
): SuppressionEntryRecord {
  return {
    id: `entry-${overrides.value}`,
    personId: null,
    schoolId: null,
    districtId: null,
    stateId: null,
    reason: 'opt-out',
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

describe('csv rendering', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
  });

  it('emits a header row followed by data rows', () => {
    const csv = renderCsv(PEOPLE_EXPORT_COLUMNS, [row({ personId: 'p1' })]);
    const [header] = csv.split('\r\n');
    expect(header).toContain('published_email');
    expect(header).toContain('inferred_email_candidate');
  });
});

describe('exportPeopleCsv', () => {
  it('writes allowed rows and reports the checksum', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2' })],
      suppression: SuppressionIndex.empty(),
      at: NOW,
    });
    expect(result.rowCount).toBe(2);
    expect(result.suppressedCount).toBe(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('withholds a suppressed address from the file', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2' })],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'p2@sample-isd.example.org' }),
      ]),
      at: NOW,
    });
    expect(result.rowCount).toBe(1);
    expect(result.suppressedCount).toBe(1);
    expect(result.csv).not.toContain('p2@sample-isd.example.org');
    expect(result.suppressedPersonIds).toEqual(['p2']);
  });

  it('withholds a person whose district opted out', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' })],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'district', value: 'district-1', districtId: 'district-1' }),
      ]),
      at: NOW,
    });
    expect(result.rowCount).toBe(0);
    expect(result.csv.split('\r\n').filter(Boolean)).toHaveLength(1);
  });

  it('does not let an inferred candidate smuggle out a suppressed person', () => {
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: null,
          inferredEmailCandidate: 'jane.smith@sample-isd.example.org',
          emailClassification: 'inferred_candidate',
          inferenceConfidence: 0.8,
        }),
      ],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'jane.smith@sample-isd.example.org' }),
      ]),
      at: NOW,
    });
    expect(result.rowCount).toBe(0);
    expect(result.suppressedCount).toBe(1);
  });

  it('applies a domain opt-out to every address on that domain', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2' })],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'domain', value: 'sample-isd.example.org' }),
      ]),
      at: NOW,
    });
    expect(result.rowCount).toBe(0);
    expect(result.suppressedCount).toBe(2);
  });

  it('keeps published and inferred addresses in separate columns', () => {
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: 'published@sample-isd.example.org',
          inferredEmailCandidate: 'guess@sample-isd.example.org',
        }),
      ],
      suppression: SuppressionIndex.empty(),
      at: NOW,
    });
    const [header, first] = result.csv.split('\r\n');
    const publishedIndex = header!.split(',').indexOf('published_email');
    const inferredIndex = header!.split(',').indexOf('inferred_email_candidate');
    const cells = first!.split(',');
    expect(cells[publishedIndex]).toBe('published@sample-isd.example.org');
    expect(cells[inferredIndex]).toBe('guess@sample-isd.example.org');
  });

  it('records the moment suppression was checked', () => {
    const result = exportPeopleCsv({ rows: [], suppression: SuppressionIndex.empty(), at: NOW });
    expect(result.suppressionCheckedAt).toBe(NOW);
  });

  it('an opt-out recorded after a previous export still takes effect', () => {
    const rows = [row({ personId: 'p1' })];
    const firstExport = exportPeopleCsv({
      rows,
      suppression: SuppressionIndex.empty(),
      at: '2026-05-01T00:00:00.000Z',
    });
    expect(firstExport.rowCount).toBe(1);

    const laterSuppression = SuppressionIndex.fromEntries([
      suppress({
        scope: 'person',
        value: 'p1',
        personId: 'p1',
        effectiveAt: '2026-05-15T00:00:00.000Z',
      }),
    ]);
    const secondExport = exportPeopleCsv({ rows, suppression: laterSuppression, at: NOW });
    expect(secondExport.rowCount).toBe(0);
  });

  it('throws rather than writing when a suppressed row reaches the second pass', () => {
    const suppression = SuppressionIndex.fromEntries([
      suppress({ scope: 'email', value: 'p1@sample-isd.example.org' }),
    ]);
    expect(() =>
      suppression.assertNotSuppressed({ emailAddress: 'p1@sample-isd.example.org' }, NOW),
    ).toThrow(SuppressionError);
  });
});
