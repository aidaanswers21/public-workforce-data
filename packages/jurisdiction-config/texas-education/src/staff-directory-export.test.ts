import { describe, expect, it } from 'vitest';
import { SuppressionIndex, type ExportablePersonRow } from '@public-workforce/core';
import type { SuppressionEntryRecord } from '@public-workforce/shared-types';
import { exportTexasEducationStaffDirectoryCsv } from './staff-directory-export.js';

const NOW = '2026-09-11T00:00:00.000Z';

function row(personId: string, sourceDocumentId: string): ExportablePersonRow {
  return {
    personId,
    assignmentId: `assignment-${personId}`,
    publishedEmails: [
      {
        value: `${personId}@district.example.org`,
        classification: 'published',
        validationStatus: 'unvalidated',
        obfuscationKind: 'none',
        sourceDocumentId,
        sourceUrl: `https://district.example.org/directory/${personId}`,
        sourceTypeCode: 'operator_supplied_artifact',
        sourceVersion: 1,
        sourceRetrievedAt: NOW,
        sourceDataset: 'batch-2',
        sourceFile: 'accepted.jsonl',
        sourceLine: '17',
        qaIdentityMethod: 'exact organization key',
      },
    ],
    workPhones: [],
    firstName: 'Ana',
    middleName: null,
    lastName: 'Rivera',
    fullNamePublished: 'Ana Rivera',
    titlePublished: 'Math Teacher',
    titleNormalized: 'math teacher',
    roleCategoryCode: 'teacher',
    jobFamilyCode: 'instruction',
    seniorityCode: 'staff',
    specialty: 'Mathematics',
    departmentPublished: 'Mathematics',
    organizationalUnitName: null,
    organizationId: 'organization-1',
    organizationName: 'Fixture School',
    organizationWebsiteUrl: 'https://district.example.org',
    organizationTypeCode: 'school',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    parentOrganizationId: 'district-1',
    parentOrganizationName: 'Fixture District',
    organizationAncestorIds: ['district-1'],
    jurisdictionId: 'texas-education',
    jurisdictionName: 'Texas public education',
    dutyLocationCity: 'Austin',
    dutyLocationStateCode: 'TX',
    dutyLocationCountyName: 'Travis',
    geographicAreaIds: [],
    publishedEmail: `${personId}@district.example.org`,
    inferredEmailCandidate: null,
    inferredCandidateWithheld: false,
    emailClassification: 'published',
    emailValidationStatus: 'unvalidated',
    inferenceConfidence: null,
    sourceUrl: 'https://archive.example.test/artifact',
    sourceTypeCode: 'operator_supplied_artifact',
    sourceDocumentId,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    crawlRunId: null,
    extractionMethod: 'file_import',
    confidence: 0.8,
    assignmentStatus: 'active',
    status: 'active',
  };
}

function sourceSuppression(sourceDocumentId: string): SuppressionEntryRecord {
  return {
    id: 'suppression-1',
    scope: 'source',
    value: sourceDocumentId,
    personId: null,
    organizationId: null,
    jurisdictionId: null,
    geographicAreaId: null,
    sourceDocumentId,
    governmentLevelCode: null,
    exportPurpose: null,
    reason: 'fixture source suppression',
    source: 'manual_review',
    effectiveAt: NOW,
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    createdBy: 'test',
    createdAt: NOW,
  };
}

describe('Texas education staff-directory export', () => {
  it('derives the teacher flag and published grade range in the jurisdiction layer', () => {
    const result = exportTexasEducationStaffDirectoryCsv({
      rows: [row('ana', 'artifact-doc-1')],
      suppression: SuppressionIndex.empty(),
      at: NOW,
      purpose: 'internal-review',
      gradeRangesByOrganizationId: new Map([
        ['organization-1', { lowGrade: 'KG', highGrade: '05' }],
      ]),
    });

    expect(result.rowCount).toBe(1);
    expect(result.csv.split('\r\n')[0]).toContain('is_teacher');
    expect(result.csv).toContain(',true,');
    expect(result.csv).toContain('KG-05');
    expect(result.csv).toContain('https://district.example.org/directory/ana');
    expect(result.csv).toContain('artifact-doc-1');
  });

  it('re-checks artifact-source suppression for an imported row', () => {
    const result = exportTexasEducationStaffDirectoryCsv({
      rows: [row('ana', 'artifact-doc-1')],
      suppression: SuppressionIndex.fromEntries([sourceSuppression('artifact-doc-1')]),
      at: NOW,
      purpose: 'internal-review',
    });

    expect(result.rowCount).toBe(0);
    expect(result.csv).not.toContain('ana@district.example.org');
  });
});
