import type {
  AssignmentStatus,
  EmailClassification,
  ExtractionMethod,
  NameParts,
  NormalizationMethod,
  ObfuscationKind,
  Timestamp,
  Uuid,
} from '@pan/shared-types';
import type { SqlClient } from '../client.js';

export interface UpsertSourceDocumentInput {
  url: string;
  urlCanonical: string;
  urlHash: string;
  domain: string;
  sourceTypeCode: string;
  httpStatus: number | null;
  contentHash: string | null;
  contentType: string | null;
  storageKey: string | null;
  robotsAllowed: boolean | null;
  robotsPolicyNote: string | null;
  sourcePolicyId?: Uuid | null;
  crawlRunId: Uuid | null;
  retrievedAt: Timestamp;
}

export interface ObservationInput {
  sourceDocumentId: Uuid;
  crawlRunId: Uuid | null;
  /** What this observation proves: organization, employment, contact, location, policy. */
  evidenceClass: string;
  entityType: string;
  entityId: Uuid | null;
  recordKey: string;
  field: string;
  valueRaw: string | null;
  valueNormalized: string | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  selector: string | null;
  observedAt: Timestamp;
}

export interface IngestEmailInput {
  address: string;
  addressNormalized: string;
  domain: string;
  localPart: string;
  /** Observed classes only. Inferred addresses live in `email_candidates`. */
  classification: Extract<
    EmailClassification,
    'published' | 'decoded_published' | 'general_inbox' | 'invalid'
  >;
  obfuscation: ObfuscationKind;
  sourceValue: string | null;
}

export interface IngestContactPointInput {
  contactPointTypeCode: string;
  value: string;
  valueNormalized: string;
  sourceValue: string | null;
}

export interface IngestPersonInput {
  recordKey: string;
  organizationId: Uuid;
  organizationalUnitId: Uuid | null;
  dutyLocationId: Uuid | null;
  fullNamePublished: string;
  nameParts: NameParts;
  identityKey: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  specialty: string | null;
  normalizationMethod: NormalizationMethod;
  normalizationRuleSource: string | null;
  taxonomyVersion: string;
  normalizationConfidence: number;
  departmentPublished: string | null;
  assignmentStatus?: AssignmentStatus;
  effectiveFrom?: string | null;
  emails: readonly IngestEmailInput[];
  contactPoints?: readonly IngestContactPointInput[];
  sourceDocumentId: Uuid;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  observedAt: Timestamp;
}

export interface IngestPersonResult {
  personId: Uuid;
  employmentAssignmentId: Uuid;
  emailAddressIds: Uuid[];
  contactPointIds: Uuid[];
  personCreated: boolean;
}

/**
 * The write path for collected people.
 *
 * Every statement is an upsert keyed on something stable, so running the same
 * collection twice converges on the same rows instead of accumulating
 * duplicates. `first_seen_at` only moves earlier and `last_seen_at` only moves
 * later, which is what keeps "still published by the source" distinguishable
 * from "found today" after any number of re-runs.
 */
export class IngestionRepository {
  constructor(private readonly client: SqlClient) {}

  async upsertSourceDocument(input: UpsertSourceDocumentInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code, http_status, content_hash,
         content_type, storage_key, robots_allowed, robots_policy_note, source_policy_id,
         crawl_run_id, retrieved_at, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14)
       on conflict (url_hash) do update set
         http_status = excluded.http_status,
         content_hash = excluded.content_hash,
         content_type = excluded.content_type,
         storage_key = coalesce(excluded.storage_key, source_documents.storage_key),
         robots_allowed = excluded.robots_allowed,
         robots_policy_note = excluded.robots_policy_note,
         source_policy_id = coalesce(excluded.source_policy_id, source_documents.source_policy_id),
         crawl_run_id = excluded.crawl_run_id,
         retrieved_at = excluded.retrieved_at,
         last_seen_at = greatest(source_documents.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        input.url,
        input.urlCanonical,
        input.urlHash,
        input.domain,
        input.sourceTypeCode,
        input.httpStatus,
        input.contentHash,
        input.contentType,
        input.storageKey,
        input.robotsAllowed,
        input.robotsPolicyNote,
        input.sourcePolicyId ?? null,
        input.crawlRunId,
        input.retrievedAt,
      ],
    );
    return requireId(result.rows[0], 'source_documents');
  }

  async recordObservation(input: ObservationInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into source_observations (
         source_document_id, crawl_run_id, evidence_class, entity_type, entity_id, record_key,
         field, value_raw, value_normalized, extraction_method, confidence, selector, observed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (source_document_id, record_key, field) do update set
         entity_id = coalesce(excluded.entity_id, source_observations.entity_id),
         value_raw = excluded.value_raw,
         value_normalized = excluded.value_normalized,
         confidence = greatest(source_observations.confidence, excluded.confidence),
         observed_at = excluded.observed_at
       returning id`,
      [
        input.sourceDocumentId,
        input.crawlRunId,
        input.evidenceClass,
        input.entityType,
        input.entityId,
        input.recordKey,
        input.field,
        input.valueRaw,
        input.valueNormalized,
        input.extractionMethod,
        input.confidence,
        input.selector,
        input.observedAt,
      ],
    );
    return requireId(result.rows[0], 'source_observations');
  }

  /**
   * Insert or refresh one person, their assignment, their published addresses
   * and their other professional contact points.
   *
   * The email insert never downgrades a stored classification: `decoded_published`
   * may be replaced by `published` when a later page shows the address in plain
   * text, and nothing moves the other way.
   */
  async ingestPerson(input: IngestPersonInput): Promise<IngestPersonResult> {
    const personResult = await this.client.query<{ id: Uuid; created: boolean }>(
      `insert into people (
         full_name_published, name_prefix, first_name, middle_name, last_name, name_suffix,
         identity_key, source_document_id, crawl_run_id, extraction_method, confidence,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       on conflict (identity_key) do update set
         full_name_published = case
           when length(excluded.full_name_published) > length(people.full_name_published)
           then excluded.full_name_published else people.full_name_published end,
         first_name = coalesce(people.first_name, excluded.first_name),
         middle_name = coalesce(people.middle_name, excluded.middle_name),
         last_name = coalesce(people.last_name, excluded.last_name),
         name_suffix = coalesce(people.name_suffix, excluded.name_suffix),
         confidence = greatest(people.confidence, excluded.confidence),
         first_seen_at = least(people.first_seen_at, excluded.first_seen_at),
         last_seen_at = greatest(people.last_seen_at, excluded.last_seen_at)
       returning id, (xmax = 0) as created`,
      [
        input.fullNamePublished,
        input.nameParts.prefix,
        input.nameParts.firstName,
        input.nameParts.middleName,
        input.nameParts.lastName,
        input.nameParts.suffix,
        input.identityKey,
        input.sourceDocumentId,
        input.crawlRunId,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    const person = personResult.rows[0];
    const personId = requireId(person, 'people');

    const assignmentResult = await this.client.query<{ id: Uuid }>(
      `insert into employment_assignments (
         person_id, organization_id, organizational_unit_id, duty_location_id, title_published,
         title_normalized, role_category_code, job_family_code, seniority_code, specialty,
         normalization_method, normalization_rule_source, taxonomy_version, normalization_confidence,
         department_published, assignment_status, effective_from, source_document_id, crawl_run_id,
         extraction_method, confidence, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
       on conflict (person_id, organization_id, organizational_unit_id, title_normalized, effective_from)
       do update set
         title_published = coalesce(excluded.title_published, employment_assignments.title_published),
         duty_location_id = coalesce(excluded.duty_location_id, employment_assignments.duty_location_id),
         role_category_code = excluded.role_category_code,
         job_family_code = excluded.job_family_code,
         seniority_code = excluded.seniority_code,
         specialty = coalesce(excluded.specialty, employment_assignments.specialty),
         normalization_rule_source = excluded.normalization_rule_source,
         taxonomy_version = excluded.taxonomy_version,
         normalization_confidence = excluded.normalization_confidence,
         department_published = coalesce(excluded.department_published, employment_assignments.department_published),
         assignment_status = excluded.assignment_status,
         confidence = greatest(employment_assignments.confidence, excluded.confidence),
         first_seen_at = least(employment_assignments.first_seen_at, excluded.first_seen_at),
         last_seen_at = greatest(employment_assignments.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        personId,
        input.organizationId,
        input.organizationalUnitId,
        input.dutyLocationId,
        input.titlePublished,
        input.titleNormalized,
        input.roleCategoryCode,
        input.jobFamilyCode,
        input.seniorityCode,
        input.specialty,
        input.normalizationMethod,
        input.normalizationRuleSource,
        input.taxonomyVersion,
        input.normalizationConfidence,
        input.departmentPublished,
        input.assignmentStatus ?? 'active',
        input.effectiveFrom ?? null,
        input.sourceDocumentId,
        input.crawlRunId,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    const employmentAssignmentId = requireId(assignmentResult.rows[0], 'employment_assignments');

    const emailAddressIds: Uuid[] = [];
    for (const email of input.emails) {
      const emailResult = await this.client.query<{ id: Uuid }>(
        `insert into email_addresses (
           person_id, employment_assignment_id, organization_id, address, address_normalized,
           domain, local_part, classification, obfuscation, source_value, source_document_id,
           crawl_run_id, extraction_method, confidence, first_seen_at, last_seen_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
         on conflict (person_id, organization_id, address_normalized) do update set
           classification = case
             when email_addresses.classification = 'published' then email_addresses.classification
             when excluded.classification = 'published' then excluded.classification
             else email_addresses.classification end,
           obfuscation = case
             when excluded.classification = 'published' then excluded.obfuscation
             else email_addresses.obfuscation end,
           employment_assignment_id = coalesce(excluded.employment_assignment_id, email_addresses.employment_assignment_id),
           confidence = greatest(email_addresses.confidence, excluded.confidence),
           first_seen_at = least(email_addresses.first_seen_at, excluded.first_seen_at),
           last_seen_at = greatest(email_addresses.last_seen_at, excluded.last_seen_at)
         returning id`,
        [
          personId,
          employmentAssignmentId,
          input.organizationId,
          email.address,
          email.addressNormalized,
          email.domain,
          email.localPart,
          email.classification,
          email.obfuscation,
          email.sourceValue,
          input.sourceDocumentId,
          input.crawlRunId,
          input.extractionMethod,
          input.confidence,
          input.observedAt,
        ],
      );
      emailAddressIds.push(requireId(emailResult.rows[0], 'email_addresses'));
    }

    const contactPointIds: Uuid[] = [];
    for (const contact of input.contactPoints ?? []) {
      const contactResult = await this.client.query<{ id: Uuid }>(
        `insert into contact_points (
           person_id, employment_assignment_id, organization_id, contact_point_type_code, value,
           value_normalized, source_value, source_document_id, crawl_run_id, extraction_method,
           confidence, first_seen_at, last_seen_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         on conflict (person_id, organization_id, contact_point_type_code, value_normalized)
         do update set
           employment_assignment_id = coalesce(excluded.employment_assignment_id, contact_points.employment_assignment_id),
           confidence = greatest(contact_points.confidence, excluded.confidence),
           last_seen_at = greatest(contact_points.last_seen_at, excluded.last_seen_at)
         returning id`,
        [
          personId,
          employmentAssignmentId,
          input.organizationId,
          contact.contactPointTypeCode,
          contact.value,
          contact.valueNormalized,
          contact.sourceValue,
          input.sourceDocumentId,
          input.crawlRunId,
          input.extractionMethod,
          input.confidence,
          input.observedAt,
        ],
      );
      contactPointIds.push(requireId(contactResult.rows[0], 'contact_points'));
    }

    return {
      personId,
      employmentAssignmentId,
      emailAddressIds,
      contactPointIds,
      personCreated: person?.created === true,
    };
  }
}

function requireId(row: { id?: Uuid } | undefined, table: string): Uuid {
  const id = row?.id;
  if (id === undefined) throw new Error(`${table}: upsert returned no id`);
  return id;
}
