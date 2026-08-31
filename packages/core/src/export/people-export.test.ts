import { describe, expect, it } from 'vitest';
import type { SuppressionEntryRecord } from '@public-workforce/shared-types';
import { OrganizationHierarchy, SuppressionError, SuppressionIndex } from '../suppression.js';
import { csvEscape, renderCsv } from './csv.js';
import {
  PEOPLE_EXPORT_COLUMNS,
  exportPeopleCsv,
  type ExportablePersonRow,
} from './people-export.js';

const NOW = '2026-06-01T00:00:00.000Z';
const PURPOSE = 'internal-review';

/** A federal department, its bureau, and a field office under the bureau. */
const HIERARCHY = new OrganizationHierarchy([
  { parentOrganizationId: 'dept', childOrganizationId: 'bureau' },
  { parentOrganizationId: 'bureau', childOrganizationId: 'field-office' },
]);

function row(overrides: Partial<ExportablePersonRow> & { personId: string }): ExportablePersonRow {
  const organizationId = overrides.organizationId ?? 'bureau';
  return {
    firstName: 'Jane',
    middleName: null,
    lastName: 'Smith',
    fullNamePublished: 'Jane Smith',
    titlePublished: 'Program Analyst',
    titleNormalized: 'Program Analyst',
    roleCategoryCode: 'program_analyst',
    jobFamilyCode: 'research_policy',
    seniorityCode: 'staff',
    departmentPublished: null,
    organizationalUnitName: 'Office of Policy',
    organizationId,
    organizationName: 'Sample Bureau',
    organizationTypeCode: 'federal_bureau',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    parentOrganizationId: 'dept',
    parentOrganizationName: 'Sample Department',
    organizationAncestorIds: HIERARCHY.ancestorsOf(organizationId),
    jurisdictionId: 'us-federal',
    jurisdictionName: 'United States',
    dutyLocationCity: 'Denver',
    dutyLocationStateCode: 'CO',
    dutyLocationCountyName: 'Denver',
    geographicAreaIds: ['area-co'],
    publishedEmail: `${overrides.personId}@agency.example.gov`,
    inferredEmailCandidate: null,
    emailClassification: 'published',
    emailValidationStatus: 'unvalidated',
    inferenceConfidence: null,
    sourceUrl: 'https://agency.example.gov/leadership',
    sourceTypeCode: 'html_directory',
    sourceDocumentId: 'doc-1',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: NOW,
    crawlRunId: 'run-1',
    extractionMethod: 'html_table',
    confidence: 0.9,
    assignmentStatus: 'active',
    status: 'active',
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
    organizationId: null,
    jurisdictionId: null,
    geographicAreaId: null,
    sourceDocumentId: null,
    governmentLevelCode: null,
    exportPurpose: null,
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

  it('emits a header carrying organization, level and duty location', () => {
    const csv = renderCsv(PEOPLE_EXPORT_COLUMNS, [row({ personId: 'p1' })]);
    const header = (csv.split('\r\n')[0] ?? '').split(',');
    for (const column of [
      'organization',
      'organization_type',
      'parent_organization',
      'government_level',
      'sector',
      'jurisdiction',
      'duty_location_city',
      'duty_location_state',
      'published_email',
      'inferred_email_candidate',
      'assignment_status',
    ]) {
      expect(header).toContain(column);
    }
  });
});

describe('exportPeopleCsv', () => {
  it('writes allowed rows and reports the checksum', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2' })],
      suppression: SuppressionIndex.empty(),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.rowCount).toBe(2);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('withholds a suppressed address from the file', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2' })],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'p2@agency.example.gov' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.rowCount).toBe(1);
    expect(result.csv).not.toContain('p2@agency.example.gov');
    expect(result.suppressedPersonIds).toEqual(['p2']);
  });

  it('withholds everyone beneath a suppressed organization subtree', () => {
    const result = exportPeopleCsv({
      rows: [
        row({ personId: 'p1', organizationId: 'bureau' }),
        row({ personId: 'p2', organizationId: 'field-office' }),
        row({ personId: 'p3', organizationId: 'unrelated' }),
      ],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'organization_subtree', value: 'dept', organizationId: 'dept' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.rowCount).toBe(1);
    expect(result.suppressedCount).toBe(2);
    expect(result.csv).toContain('p3@agency.example.gov');
  });

  it('withholds a whole level of government when asked', () => {
    const result = exportPeopleCsv({
      rows: [row({ personId: 'p1' }), row({ personId: 'p2', governmentLevelCode: 'county' })],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'government_level', value: 'federal', governmentLevelCode: 'federal' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.rowCount).toBe(1);
  });

  it('withholds a record from one declared purpose but not another', () => {
    const suppression = SuppressionIndex.fromEntries([
      suppress({ scope: 'export_purpose', value: 'outreach', exportPurpose: 'outreach' }),
    ]);
    const rows = [row({ personId: 'p1' })];
    expect(exportPeopleCsv({ rows, suppression, at: NOW, purpose: 'outreach' }).rowCount).toBe(0);
    expect(
      exportPeopleCsv({ rows, suppression, at: NOW, purpose: 'internal-review' }).rowCount,
    ).toBe(1);
  });

  it('does not let an inferred candidate smuggle out a suppressed person', () => {
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: null,
          inferredEmailCandidate: 'jane.smith@agency.example.gov',
          emailClassification: 'inferred_candidate',
          inferenceConfidence: 0.8,
        }),
      ],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'jane.smith@agency.example.gov' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.rowCount).toBe(0);
  });

  it('withholds a suppressed candidate without failing the row or the export', () => {
    // The regression: both addresses were collapsed into one subject, so a
    // suppressed guess dropped a permitted published address, and the
    // second-pass assertion then threw and failed the whole export.
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: 'jane.smith@agency.example.gov',
          inferredEmailCandidate: 'j.smith@agency.example.gov',
        }),
        row({ personId: 'p2', publishedEmail: 'ravi.patel@agency.example.gov' }),
      ],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'j.smith@agency.example.gov' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });

    expect(result.rowCount).toBe(2);
    expect(result.suppressedCount).toBe(0);
    expect(result.withheldCandidateCount).toBe(1);
    expect(result.csv).toContain('jane.smith@agency.example.gov');
    expect(result.csv).not.toContain('j.smith@agency.example.gov');
  });

  it('still withholds the row when the published address is the suppressed one', () => {
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: 'jane.smith@agency.example.gov',
          inferredEmailCandidate: 'j.smith@agency.example.gov',
        }),
      ],
      suppression: SuppressionIndex.fromEntries([
        suppress({ scope: 'email', value: 'jane.smith@agency.example.gov' }),
      ]),
      at: NOW,
      purpose: PURPOSE,
    });
    // Exporting the guess instead would be an obvious way around the request.
    expect(result.rowCount).toBe(0);
    expect(result.csv).not.toContain('j.smith@agency.example.gov');
  });

  it('keeps published and inferred addresses in separate columns', () => {
    const result = exportPeopleCsv({
      rows: [
        row({
          personId: 'p1',
          publishedEmail: 'published@agency.example.gov',
          inferredEmailCandidate: 'guess@agency.example.gov',
        }),
      ],
      suppression: SuppressionIndex.empty(),
      at: NOW,
      purpose: PURPOSE,
    });
    const [header, first] = result.csv.split('\r\n');
    const cells = (first ?? '').split(',');
    const columns = (header ?? '').split(',');
    expect(cells[columns.indexOf('published_email')]).toBe('published@agency.example.gov');
    expect(cells[columns.indexOf('inferred_email_candidate')]).toBe('guess@agency.example.gov');
  });

  it('an opt-out recorded after a previous export still takes effect', () => {
    const rows = [row({ personId: 'p1' })];
    expect(
      exportPeopleCsv({
        rows,
        suppression: SuppressionIndex.empty(),
        at: '2026-05-01T00:00:00.000Z',
        purpose: PURPOSE,
      }).rowCount,
    ).toBe(1);

    const later = SuppressionIndex.fromEntries([
      suppress({
        scope: 'person',
        value: 'p1',
        personId: 'p1',
        effectiveAt: '2026-05-15T00:00:00.000Z',
      }),
    ]);
    expect(exportPeopleCsv({ rows, suppression: later, at: NOW, purpose: PURPOSE }).rowCount).toBe(
      0,
    );
  });

  it('records the moment suppression was checked', () => {
    const result = exportPeopleCsv({
      rows: [],
      suppression: SuppressionIndex.empty(),
      at: NOW,
      purpose: PURPOSE,
    });
    expect(result.suppressionCheckedAt).toBe(NOW);
  });

  it('throws rather than writing when a suppressed row reaches the second pass', () => {
    const suppression = SuppressionIndex.fromEntries([
      suppress({ scope: 'email', value: 'p1@agency.example.gov' }),
    ]);
    expect(() =>
      suppression.assertNotSuppressed({ emailAddress: 'p1@agency.example.gov' }, NOW),
    ).toThrow(SuppressionError);
  });
});
