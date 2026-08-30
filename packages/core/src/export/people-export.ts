import type {
  AssignmentStatus,
  EmailClassification,
  EmailValidationStatus,
  ExtractionMethod,
  RecordStatus,
  Timestamp,
  Uuid,
} from '@pan/shared-types';
import { sha256 } from '../hash.js';
import type { SuppressionIndex } from '../suppression.js';
import { type SuppressionSubject } from '../suppression.js';
import { renderCsv, type CsvColumn } from './csv.js';

/**
 * One exportable row.
 *
 * Neutral across every level of government: an organization, its level and its
 * jurisdiction, plus a duty location that is deliberately independent of both.
 * A federal row carries no state parent and a school row carries no assumption
 * that its county governs it.
 *
 * Published and inferred addresses occupy separate columns and are never merged,
 * so a consumer who ignores the classification column still cannot mistake one
 * for the other.
 */
export interface ExportablePersonRow {
  personId: Uuid;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  fullNamePublished: string;

  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  departmentPublished: string | null;
  organizationalUnitName: string | null;

  organizationId: Uuid | null;
  organizationName: string | null;
  organizationTypeCode: string | null;
  governmentLevelCode: string | null;
  sectorCode: string | null;
  /** The organization directly above this one, when there is one. Often null. */
  parentOrganizationId: Uuid | null;
  parentOrganizationName: string | null;
  /** Every organization above this one. Drives subtree suppression. */
  organizationAncestorIds: readonly Uuid[];

  jurisdictionId: Uuid | null;
  jurisdictionName: string | null;

  /** Where the person works, which need not be where the employer is seated. */
  dutyLocationCity: string | null;
  dutyLocationStateCode: string | null;
  dutyLocationCountyName: string | null;
  /** Areas the duty location sits in. Drives geographic-area suppression. */
  geographicAreaIds: readonly Uuid[];

  publishedEmail: string | null;
  inferredEmailCandidate: string | null;
  emailClassification: EmailClassification | null;
  emailValidationStatus: EmailValidationStatus;
  inferenceConfidence: number | null;

  sourceUrl: string | null;
  sourceTypeCode: string | null;
  sourceDocumentId: Uuid | null;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  assignmentStatus: AssignmentStatus;
  status: RecordStatus;
}

export const PEOPLE_EXPORT_COLUMNS: readonly CsvColumn<ExportablePersonRow>[] = [
  { header: 'first_name', value: (row) => row.firstName },
  { header: 'middle_name', value: (row) => row.middleName },
  { header: 'last_name', value: (row) => row.lastName },
  { header: 'full_name_published', value: (row) => row.fullNamePublished },
  { header: 'title', value: (row) => row.titlePublished },
  { header: 'title_normalized', value: (row) => row.titleNormalized },
  { header: 'role_category', value: (row) => row.roleCategoryCode },
  { header: 'job_family', value: (row) => row.jobFamilyCode },
  { header: 'seniority', value: (row) => row.seniorityCode },
  { header: 'department', value: (row) => row.organizationalUnitName ?? row.departmentPublished },
  { header: 'organization', value: (row) => row.organizationName },
  { header: 'organization_type', value: (row) => row.organizationTypeCode },
  { header: 'parent_organization', value: (row) => row.parentOrganizationName },
  { header: 'government_level', value: (row) => row.governmentLevelCode },
  { header: 'sector', value: (row) => row.sectorCode },
  { header: 'jurisdiction', value: (row) => row.jurisdictionName },
  { header: 'duty_location_city', value: (row) => row.dutyLocationCity },
  { header: 'duty_location_county', value: (row) => row.dutyLocationCountyName },
  { header: 'duty_location_state', value: (row) => row.dutyLocationStateCode },
  { header: 'published_email', value: (row) => row.publishedEmail },
  { header: 'inferred_email_candidate', value: (row) => row.inferredEmailCandidate },
  { header: 'email_classification', value: (row) => row.emailClassification },
  { header: 'email_validation_status', value: (row) => row.emailValidationStatus },
  { header: 'inference_confidence', value: (row) => row.inferenceConfidence },
  { header: 'source_url', value: (row) => row.sourceUrl },
  { header: 'source_type', value: (row) => row.sourceTypeCode },
  { header: 'first_seen_at', value: (row) => row.firstSeenAt },
  { header: 'last_seen_at', value: (row) => row.lastSeenAt },
  { header: 'crawl_run_id', value: (row) => row.crawlRunId },
  { header: 'extraction_method', value: (row) => row.extractionMethod },
  { header: 'confidence', value: (row) => row.confidence },
  { header: 'assignment_status', value: (row) => row.assignmentStatus },
  { header: 'status', value: (row) => row.status },
];

export interface ExportResult {
  csv: string;
  rowCount: number;
  suppressedCount: number;
  checksum: string;
  suppressionCheckedAt: Timestamp;
  /** Ids of records withheld, for the audit trail. Never their addresses. */
  suppressedPersonIds: readonly Uuid[];
}

/** Everything suppression is evaluated against for one row. */
export function exportSubject(row: ExportablePersonRow, purpose: string): SuppressionSubject {
  return {
    emailAddress: row.publishedEmail ?? row.inferredEmailCandidate ?? null,
    personId: row.personId,
    organizationId: row.organizationId,
    organizationAncestorIds: row.organizationAncestorIds,
    jurisdictionId: row.jurisdictionId,
    governmentLevelCode: row.governmentLevelCode,
    geographicAreaIds: row.geographicAreaIds,
    sourceDocumentId: row.sourceDocumentId,
    exportPurpose: purpose,
  };
}

/**
 * Render an export, re-checking suppression immediately before the file exists.
 *
 * The re-check is the point of this function. Rows arrive already filtered by
 * the data layer, but an opt-out recorded between the query and the write must
 * still take effect, and a record that appeared in an older export gets no
 * grandfathering. Both addresses on a row are checked, so an inferred candidate
 * cannot smuggle out a person whose published address is suppressed.
 */
export function exportPeopleCsv(input: {
  rows: readonly ExportablePersonRow[];
  suppression: SuppressionIndex;
  at: Timestamp;
  /** Declared purpose, matched against `export_purpose` suppression entries. */
  purpose: string;
}): ExportResult {
  const subjectOf = (row: ExportablePersonRow): SuppressionSubject =>
    exportSubject(row, input.purpose);
  const { allowed, suppressed } = input.suppression.partition(input.rows, subjectOf, input.at);

  // Second pass over the survivors. Cheap, and it means a bug in `partition`
  // cannot put a suppressed address into a file.
  for (const row of allowed) {
    input.suppression.assertNotSuppressed(subjectOf(row), input.at);
    if (row.publishedEmail !== null) {
      input.suppression.assertNotSuppressed(
        { ...subjectOf(row), emailAddress: row.publishedEmail },
        input.at,
      );
    }
    if (row.inferredEmailCandidate !== null) {
      input.suppression.assertNotSuppressed(
        { ...subjectOf(row), emailAddress: row.inferredEmailCandidate },
        input.at,
      );
    }
  }

  const csv = renderCsv(PEOPLE_EXPORT_COLUMNS, allowed);
  return {
    csv,
    rowCount: allowed.length,
    suppressedCount: suppressed.length,
    checksum: sha256(csv),
    suppressionCheckedAt: input.at,
    suppressedPersonIds: suppressed.map((entry) => entry.item.personId),
  };
}
