import type {
  EmailClassification,
  EmailValidationStatus,
  ExtractionMethod,
  RecordStatus,
  RoleCategory,
  SourceType,
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
 * Published and inferred addresses occupy separate columns and are never merged
 * into one, so a consumer of the file cannot mistake one for the other even if
 * they ignore the classification column.
 */
export interface ExportablePersonRow {
  personId: Uuid;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  fullNamePublished: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategory: RoleCategory;
  department: string | null;
  schoolName: string | null;
  districtName: string | null;
  countyName: string | null;
  stateCode: string;

  publishedEmail: string | null;
  inferredEmailCandidate: string | null;
  emailClassification: EmailClassification | null;
  emailValidationStatus: EmailValidationStatus;
  /** Inference confidence. Never a deliverability claim. */
  inferenceConfidence: number | null;

  sourceUrl: string | null;
  sourceType: SourceType | null;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  status: RecordStatus;

  schoolId: Uuid | null;
  districtId: Uuid | null;
  stateId: Uuid | null;
}

export const PEOPLE_EXPORT_COLUMNS: readonly CsvColumn<ExportablePersonRow>[] = [
  { header: 'first_name', value: (row) => row.firstName },
  { header: 'middle_name', value: (row) => row.middleName },
  { header: 'last_name', value: (row) => row.lastName },
  { header: 'full_name_published', value: (row) => row.fullNamePublished },
  { header: 'title', value: (row) => row.titlePublished },
  { header: 'title_normalized', value: (row) => row.titleNormalized },
  { header: 'role_category', value: (row) => row.roleCategory },
  { header: 'department', value: (row) => row.department },
  { header: 'school', value: (row) => row.schoolName },
  { header: 'district', value: (row) => row.districtName },
  { header: 'county', value: (row) => row.countyName },
  { header: 'state', value: (row) => row.stateCode },
  { header: 'published_email', value: (row) => row.publishedEmail },
  { header: 'inferred_email_candidate', value: (row) => row.inferredEmailCandidate },
  { header: 'email_classification', value: (row) => row.emailClassification },
  { header: 'email_validation_status', value: (row) => row.emailValidationStatus },
  { header: 'inference_confidence', value: (row) => row.inferenceConfidence },
  { header: 'source_url', value: (row) => row.sourceUrl },
  { header: 'source_type', value: (row) => row.sourceType },
  { header: 'first_seen_at', value: (row) => row.firstSeenAt },
  { header: 'last_seen_at', value: (row) => row.lastSeenAt },
  { header: 'crawl_run_id', value: (row) => row.crawlRunId },
  { header: 'extraction_method', value: (row) => row.extractionMethod },
  { header: 'confidence', value: (row) => row.confidence },
  { header: 'status', value: (row) => row.status },
];

export interface ExportResult {
  csv: string;
  rowCount: number;
  suppressedCount: number;
  /** sha256 of the rendered file, recorded on the `exports` row. */
  checksum: string;
  suppressionCheckedAt: Timestamp;
  /** Ids of records withheld, for the audit trail. Never their addresses. */
  suppressedPersonIds: readonly Uuid[];
}

export function exportSubject(row: ExportablePersonRow): SuppressionSubject {
  return {
    emailAddress: row.publishedEmail ?? row.inferredEmailCandidate ?? null,
    personId: row.personId,
    schoolId: row.schoolId,
    districtId: row.districtId,
    stateId: row.stateId,
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
}): ExportResult {
  const { allowed, suppressed } = input.suppression.partition(input.rows, exportSubject, input.at);

  // Second pass over the rows that survived. Cheap, and it means a bug in
  // `partition` cannot put a suppressed address into a file.
  for (const row of allowed) {
    input.suppression.assertNotSuppressed(exportSubject(row), input.at);
    if (row.publishedEmail !== null) {
      input.suppression.assertNotSuppressed(
        { ...exportSubject(row), emailAddress: row.publishedEmail },
        input.at,
      );
    }
    if (row.inferredEmailCandidate !== null) {
      input.suppression.assertNotSuppressed(
        { ...exportSubject(row), emailAddress: row.inferredEmailCandidate },
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
