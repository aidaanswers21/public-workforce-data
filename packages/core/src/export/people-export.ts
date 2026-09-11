import type {
  AssignmentStatus,
  EmailClassification,
  EmailValidationStatus,
  ExtractionMethod,
  RecordStatus,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
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
  assignmentId?: Uuid;
  publishedEmails?: readonly PublishedEmailExportValue[];
  workPhones?: readonly { value: string; sourceDocumentId: Uuid }[];
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  fullNamePublished: string;

  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  specialty: string | null;
  departmentPublished: string | null;
  organizationalUnitName: string | null;

  organizationId: Uuid | null;
  organizationName: string | null;
  organizationWebsiteUrl: string | null;
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
  /** SQL withheld a candidate address without returning the address itself. */
  inferredCandidateWithheld: boolean;
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

/** Provenance carried by each address so directory exports can be one row per observation. */
export interface PublishedEmailExportValue {
  value: string;
  classification: EmailClassification;
  validationStatus: EmailValidationStatus;
  obfuscationKind?: string | null;
  sourceDocumentId: Uuid;
  sourceUrl?: string | null;
  sourceTypeCode?: string | null;
  sourceVersion?: number | null;
  sourceRetrievedAt?: Timestamp | null;
  firstSeenAt?: Timestamp | null;
  lastSeenAt?: Timestamp | null;
  crawlRunId?: Uuid | null;
  extractionMethod?: ExtractionMethod | null;
  confidence?: number | null;
  identityConflict?: boolean;
  gradeRangePublished?: string | null;
  organizationWebsitePublished?: string | null;
  locationPublished?: string | null;
  cityPublished?: string | null;
  countyPublished?: string | null;
  statePublished?: string | null;
  emailSourceDescription?: string | null;
  sourceDataset?: string | null;
  sourceFile?: string | null;
  sourceLine?: string | null;
  qaIdentityMethod?: string | null;
}

export type PeopleExportFormat = 'full' | 'contacts' | 'staff_directory';

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
  { header: 'specialty', value: (row) => row.specialty },
  { header: 'department', value: (row) => row.organizationalUnitName ?? row.departmentPublished },
  { header: 'organization', value: (row) => row.organizationName },
  { header: 'organization_website', value: (row) => row.organizationWebsiteUrl },
  { header: 'organization_type', value: (row) => row.organizationTypeCode },
  { header: 'parent_organization', value: (row) => row.parentOrganizationName },
  { header: 'government_level', value: (row) => row.governmentLevelCode },
  { header: 'sector', value: (row) => row.sectorCode },
  { header: 'jurisdiction', value: (row) => row.jurisdictionName },
  { header: 'duty_location_city', value: (row) => row.dutyLocationCity },
  { header: 'duty_location_county', value: (row) => row.dutyLocationCountyName },
  { header: 'duty_location_state', value: (row) => row.dutyLocationStateCode },
  {
    header: 'work_phones',
    value: (row) => row.workPhones?.map((phone) => phone.value).join(' | ') ?? null,
  },
  {
    header: 'all_published_emails',
    value: (row) => row.publishedEmails?.map((email) => email.value).join(' | ') ?? null,
  },
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

interface StaffDirectoryExportRow {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  fullNamePublished: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  department: string | null;
  organizationName: string | null;
  parentOrganizationName: string | null;
  organizationWebsiteUrl: string | null;
  email: string;
  emailClassification: EmailClassification;
  emailValidationStatus: EmailValidationStatus;
  emailObfuscationKind: string | null;
  emailIdentityConflict: boolean;
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  specialty: string | null;
  roleCategoryFlag: boolean | null;
  gradeRangePublished: string | null;
  locationPublished: string | null;
  dutyLocationCity: string | null;
  dutyLocationCountyName: string | null;
  dutyLocationStateCode: string | null;
  sourceUrl: string | null;
  sourceTypeCode: string | null;
  sourceDocumentId: Uuid;
  sourceVersion: number | null;
  sourceRetrievedAt: Timestamp | null;
  emailFirstSeenAt: Timestamp | null;
  emailLastSeenAt: Timestamp | null;
  assignmentFirstSeenAt: Timestamp;
  assignmentLastSeenAt: Timestamp;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod | null;
  confidence: number | null;
  importSourceDataset: string | null;
  importSourceFile: string | null;
  importSourceLine: string | null;
  importQaIdentityMethod: string | null;
  emailSourceDescription: string | null;
}

const STAFF_DIRECTORY_EXPORT_COLUMNS: readonly CsvColumn<StaffDirectoryExportRow>[] = [
  { header: 'first_name', value: (row) => row.firstName },
  { header: 'middle_name', value: (row) => row.middleName },
  { header: 'last_name', value: (row) => row.lastName },
  { header: 'full_name_published', value: (row) => row.fullNamePublished },
  { header: 'title', value: (row) => row.titlePublished },
  { header: 'title_normalized', value: (row) => row.titleNormalized },
  { header: 'department', value: (row) => row.department },
  { header: 'organization', value: (row) => row.organizationName },
  { header: 'parent_organization', value: (row) => row.parentOrganizationName },
  { header: 'organization_website', value: (row) => row.organizationWebsiteUrl },
  { header: 'email', value: (row) => row.email },
  { header: 'email_classification', value: (row) => row.emailClassification },
  { header: 'email_validation_status', value: (row) => row.emailValidationStatus },
  { header: 'email_obfuscation_kind', value: (row) => row.emailObfuscationKind },
  { header: 'email_identity_conflict', value: (row) => row.emailIdentityConflict },
  { header: 'role_category', value: (row) => row.roleCategoryCode },
  { header: 'job_family', value: (row) => row.jobFamilyCode },
  { header: 'seniority', value: (row) => row.seniorityCode },
  { header: 'specialty', value: (row) => row.specialty },
  { header: 'role_category_flag', value: (row) => row.roleCategoryFlag },
  { header: 'grade_range_published', value: (row) => row.gradeRangePublished },
  { header: 'location_published', value: (row) => row.locationPublished },
  { header: 'duty_location_city', value: (row) => row.dutyLocationCity },
  { header: 'duty_location_county', value: (row) => row.dutyLocationCountyName },
  { header: 'duty_location_state', value: (row) => row.dutyLocationStateCode },
  { header: 'email_source_url', value: (row) => row.sourceUrl },
  { header: 'email_source_type', value: (row) => row.sourceTypeCode },
  { header: 'email_source_document_id', value: (row) => row.sourceDocumentId },
  { header: 'email_source_version', value: (row) => row.sourceVersion },
  { header: 'email_source_retrieved_at', value: (row) => row.sourceRetrievedAt },
  { header: 'email_first_seen_at', value: (row) => row.emailFirstSeenAt },
  { header: 'email_last_seen_at', value: (row) => row.emailLastSeenAt },
  { header: 'assignment_first_seen_at', value: (row) => row.assignmentFirstSeenAt },
  { header: 'assignment_last_seen_at', value: (row) => row.assignmentLastSeenAt },
  { header: 'crawl_run_id', value: (row) => row.crawlRunId },
  { header: 'extraction_method', value: (row) => row.extractionMethod },
  { header: 'confidence', value: (row) => row.confidence },
  { header: 'import_source_dataset', value: (row) => row.importSourceDataset },
  { header: 'import_source_file', value: (row) => row.importSourceFile },
  { header: 'import_source_line', value: (row) => row.importSourceLine },
  { header: 'import_qa_identity_method', value: (row) => row.importQaIdentityMethod },
  { header: 'email_source_description', value: (row) => row.emailSourceDescription },
];

export interface ExportResult {
  csv: string;
  rowCount: number;
  suppressedCount: number;
  checksum: string;
  suppressionCheckedAt: Timestamp;
  /**
   * Rows kept whose inferred candidate was withheld.
   *
   * Counted separately from `suppressedCount`, because the row survived: the
   * published address was permitted and only the guess was dropped.
   */
  withheldCandidateCount: number;
  /** Ids of records withheld, for the audit trail. Never their addresses. */
  suppressedPersonIds: readonly Uuid[];
}

/**
 * Everything suppression is evaluated against for one row, minus the addresses.
 *
 * The addresses are deliberately absent. A row carries two of them, a published
 * one and an inferred candidate, and collapsing them into a single subject
 * meant one decision had to stand for both: a suppressed guess dropped a
 * permitted published address, and the second pass then threw and failed the
 * whole export. They are evaluated separately below.
 */
export function exportSubject(row: ExportablePersonRow, purpose: string): SuppressionSubject {
  return {
    emailAddress: null,
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
 * grandfathering.
 *
 * Three decisions, evaluated independently:
 *
 *   1. The record itself. A person, organization, jurisdiction, level, area,
 *      source or purpose suppression withholds the whole row.
 *   2. The published address. Suppressing it blanks only that channel.
 *   3. The inferred candidate. Suppressing it blanks only that channel.
 *
 * The row survives when either independently evaluated channel survives. This
 * is not a way around suppression: a person, organization, source, purpose or
 * other record-level scope was already evaluated in step one.
 */
export interface ExportPeopleCsvInput {
  rows: readonly ExportablePersonRow[];
  suppression: SuppressionIndex;
  at: Timestamp;
  /** Declared purpose, matched against `export_purpose` suppression entries. */
  purpose: string;
  format?: PeopleExportFormat;
  /** Optional sector-owned role code surfaced as a neutral boolean flag. */
  roleCategoryFlagCode?: string;
  /** Optional sector-owned CSV header for the neutral role-category flag. */
  roleCategoryFlagHeader?: string;
  seenContactKeys?: Set<string>;
}

export function exportPeopleCsv(input: ExportPeopleCsvInput): ExportResult {
  const subjectOf = (row: ExportablePersonRow): SuppressionSubject =>
    exportSubject(row, input.purpose);

  const allowed: ExportablePersonRow[] = [];
  const suppressedPersonIds: Uuid[] = [];
  let withheldCandidates = 0;

  for (const row of input.rows) {
    if (row.inferredCandidateWithheld) withheldCandidates += 1;
    const subject = subjectOf(row);
    if (input.suppression.isSuppressed(subject, input.at)) {
      suppressedPersonIds.push(row.personId);
      continue;
    }
    const publishedSuppressed =
      row.publishedEmail !== null &&
      input.suppression.isSuppressed({ ...subject, emailAddress: row.publishedEmail }, input.at);

    const candidateSuppressed =
      row.inferredEmailCandidate !== null &&
      input.suppression.isSuppressed(
        { ...subject, emailAddress: row.inferredEmailCandidate },
        input.at,
      );

    const publishedEmail = publishedSuppressed ? null : row.publishedEmail;
    const inferredEmailCandidate = candidateSuppressed ? null : row.inferredEmailCandidate;
    const publishedEmails = (row.publishedEmails ?? []).filter(
      (email) =>
        !input.suppression.isSuppressed(
          { ...subject, emailAddress: email.value, sourceDocumentId: email.sourceDocumentId },
          input.at,
        ),
    );
    const workPhones = (row.workPhones ?? []).filter(
      (phone) =>
        !input.suppression.isSuppressed(
          { ...subject, sourceDocumentId: phone.sourceDocumentId },
          input.at,
        ),
    );
    if (
      publishedEmail === null &&
      inferredEmailCandidate === null &&
      publishedEmails.length === 0 &&
      workPhones.length === 0
    ) {
      if (publishedSuppressed || candidateSuppressed) suppressedPersonIds.push(row.personId);
      continue;
    }
    if (candidateSuppressed && !row.inferredCandidateWithheld) withheldCandidates += 1;

    allowed.push({
      ...row,
      publishedEmail,
      inferredEmailCandidate,
      publishedEmails,
      workPhones,
      ...(publishedSuppressed
        ? {
            emailClassification: null,
            emailValidationStatus: 'unvalidated' as const,
          }
        : {}),
    });
  }

  // Second pass over the survivors. Cheap, and it means a bug above cannot put
  // a suppressed address into a file.
  for (const row of allowed) {
    const subject = subjectOf(row);
    input.suppression.assertNotSuppressed(subject, input.at);
    for (const email of row.publishedEmails ?? [])
      input.suppression.assertNotSuppressed(
        { ...subject, emailAddress: email.value, sourceDocumentId: email.sourceDocumentId },
        input.at,
      );
    for (const phone of row.workPhones ?? [])
      input.suppression.assertNotSuppressed(
        { ...subject, sourceDocumentId: phone.sourceDocumentId },
        input.at,
      );
    if (row.publishedEmail !== null) {
      input.suppression.assertNotSuppressed(
        { ...subject, emailAddress: row.publishedEmail },
        input.at,
      );
    }
    if (row.inferredEmailCandidate !== null) {
      input.suppression.assertNotSuppressed(
        { ...subject, emailAddress: row.inferredEmailCandidate },
        input.at,
      );
    }
  }

  const seenContactKeys = input.seenContactKeys ?? new Set<string>();
  const emailIdentityCounts = new Map<string, Set<Uuid>>();
  for (const row of allowed) {
    for (const email of row.publishedEmails ?? []) {
      const key = JSON.stringify([row.organizationId, email.value.toLowerCase()]);
      const identities = emailIdentityCounts.get(key) ?? new Set<Uuid>();
      identities.add(row.personId);
      emailIdentityCounts.set(key, identities);
    }
  }
  const contacts = (input.format === 'contacts' ? allowed : []).flatMap((row) =>
    (row.publishedEmails ?? [])
      .filter((email) => {
        const key = JSON.stringify([row.organizationId, email.value.toLowerCase()]);
        if (seenContactKeys.has(key)) return false;
        seenContactKeys.add(key);
        return true;
      })
      .map((email) => ({
        firstName: row.firstName,
        lastName: row.lastName,
        email: email.value,
        organization: row.organizationName,
        sourcePage: email.sourceUrl ?? null,
      })),
  );
  const staffDirectory = (input.format === 'staff_directory' ? allowed : []).flatMap((row) =>
    (row.publishedEmails ?? [])
      .filter((email) => {
        const key = JSON.stringify([row.personId, row.organizationId, email.value.toLowerCase()]);
        if (seenContactKeys.has(key)) return false;
        seenContactKeys.add(key);
        return true;
      })
      .map((email): StaffDirectoryExportRow => ({
        firstName: row.firstName,
        middleName: row.middleName,
        lastName: row.lastName,
        fullNamePublished: row.fullNamePublished,
        titlePublished: row.titlePublished,
        titleNormalized: row.titleNormalized,
        department: row.organizationalUnitName ?? row.departmentPublished,
        organizationName: row.organizationName,
        parentOrganizationName: row.parentOrganizationName,
        organizationWebsiteUrl:
          row.organizationWebsiteUrl ?? email.organizationWebsitePublished ?? null,
        email: email.value,
        emailClassification: email.classification,
        emailValidationStatus: email.validationStatus,
        emailObfuscationKind: email.obfuscationKind ?? null,
        emailIdentityConflict:
          email.identityConflict === true ||
          (emailIdentityCounts.get(JSON.stringify([row.organizationId, email.value.toLowerCase()]))
            ?.size ?? 0) > 1,
        roleCategoryCode: row.roleCategoryCode,
        jobFamilyCode: row.jobFamilyCode,
        seniorityCode: row.seniorityCode,
        specialty: row.specialty,
        roleCategoryFlag:
          input.roleCategoryFlagCode === undefined
            ? null
            : row.roleCategoryCode === input.roleCategoryFlagCode,
        gradeRangePublished: email.gradeRangePublished ?? null,
        locationPublished: email.locationPublished ?? null,
        dutyLocationCity: row.dutyLocationCity ?? email.cityPublished ?? null,
        dutyLocationCountyName: row.dutyLocationCountyName ?? email.countyPublished ?? null,
        dutyLocationStateCode: row.dutyLocationStateCode ?? email.statePublished ?? null,
        sourceUrl: email.sourceUrl ?? null,
        sourceTypeCode: email.sourceTypeCode ?? null,
        sourceDocumentId: email.sourceDocumentId,
        sourceVersion: email.sourceVersion ?? null,
        sourceRetrievedAt: email.sourceRetrievedAt ?? null,
        emailFirstSeenAt: email.firstSeenAt ?? null,
        emailLastSeenAt: email.lastSeenAt ?? null,
        assignmentFirstSeenAt: row.firstSeenAt,
        assignmentLastSeenAt: row.lastSeenAt,
        crawlRunId: email.crawlRunId ?? row.crawlRunId,
        extractionMethod: email.extractionMethod ?? row.extractionMethod,
        confidence: email.confidence ?? row.confidence,
        importSourceDataset: email.sourceDataset ?? null,
        importSourceFile: email.sourceFile ?? null,
        importSourceLine: email.sourceLine ?? null,
        importQaIdentityMethod: email.qaIdentityMethod ?? null,
        emailSourceDescription: email.emailSourceDescription ?? null,
      })),
  );
  const csv =
    input.format === 'contacts'
      ? renderCsv(
          [
            { header: 'first_name', value: (row: (typeof contacts)[number]) => row.firstName },
            { header: 'last_name', value: (row: (typeof contacts)[number]) => row.lastName },
            { header: 'email', value: (row: (typeof contacts)[number]) => row.email },
            { header: 'organization', value: (row: (typeof contacts)[number]) => row.organization },
            { header: 'source_page', value: (row: (typeof contacts)[number]) => row.sourcePage },
          ],
          contacts,
        )
      : input.format === 'staff_directory'
        ? renderCsv(
            STAFF_DIRECTORY_EXPORT_COLUMNS.map((column) =>
              column.header === 'role_category_flag' && input.roleCategoryFlagHeader !== undefined
                ? {
                    ...column,
                    header: /^[a-z][a-z0-9_]{1,63}$/.test(input.roleCategoryFlagHeader)
                      ? input.roleCategoryFlagHeader
                      : 'role_category_flag',
                  }
                : column,
            ),
            staffDirectory,
          )
        : renderCsv(PEOPLE_EXPORT_COLUMNS, allowed);
  return {
    csv,
    rowCount:
      input.format === 'contacts'
        ? contacts.length
        : input.format === 'staff_directory'
          ? staffDirectory.length
          : allowed.length,
    suppressedCount: suppressedPersonIds.length,
    withheldCandidateCount: withheldCandidates,
    checksum: sha256(csv),
    suppressionCheckedAt: input.at,
    suppressedPersonIds,
  };
}
