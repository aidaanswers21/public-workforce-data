import type {
  EmailClassification,
  ExtractionMethod,
  NameParts,
  ObfuscationKind,
  RoleCategory,
  SeniorityLevel,
  SourceType,
  Timestamp,
  Uuid,
} from '@pan/shared-types';
import type { SqlClient } from '../client.js';

export interface UpsertSourcePageInput {
  url: string;
  urlCanonical: string;
  urlHash: string;
  domain: string;
  sourceType: SourceType;
  httpStatus: number | null;
  contentHash: string | null;
  contentType: string | null;
  storageKey: string | null;
  robotsAllowed: boolean | null;
  robotsPolicyNote: string | null;
  crawlRunId: Uuid | null;
  fetchedAt: Timestamp;
}

export interface ObservationInput {
  sourcePageId: Uuid;
  crawlRunId: Uuid | null;
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
  /** Observed classes only. Inferred addresses go through `insertCandidate`. */
  classification: Extract<
    EmailClassification,
    'published' | 'decoded_published' | 'general_inbox' | 'invalid'
  >;
  obfuscation: ObfuscationKind;
  sourceValue: string | null;
}

export interface IngestPersonInput {
  recordKey: string;
  stateId: Uuid;
  districtId: Uuid | null;
  schoolId: Uuid | null;
  departmentId: Uuid | null;
  fullNamePublished: string;
  nameParts: NameParts;
  identityKey: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategory: RoleCategory;
  seniority: SeniorityLevel;
  specialty: string | null;
  emails: readonly IngestEmailInput[];
  sourcePageId: Uuid;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  observedAt: Timestamp;
}

export interface IngestPersonResult {
  personId: Uuid;
  employmentAssignmentId: Uuid;
  emailAddressIds: Uuid[];
  personCreated: boolean;
}

/**
 * The write path for crawl output.
 *
 * Every statement is an upsert keyed on something stable, so running the same
 * crawl twice converges on the same rows instead of accumulating duplicates.
 * `first_seen_at` only moves earlier and `last_seen_at` only moves later, which
 * is what makes "still present on the source" distinguishable from "first found
 * today" after any number of recrawls.
 */
export class IngestionRepository {
  constructor(private readonly client: SqlClient) {}

  async upsertSourcePage(input: UpsertSourcePageInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into source_pages (
         url, url_canonical, url_hash, domain, source_type, http_status, content_hash,
         content_type, storage_key, robots_allowed, robots_policy_note, crawl_run_id,
         fetched_at, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13)
       on conflict (url_hash) do update set
         http_status = excluded.http_status,
         content_hash = excluded.content_hash,
         content_type = excluded.content_type,
         storage_key = coalesce(excluded.storage_key, source_pages.storage_key),
         robots_allowed = excluded.robots_allowed,
         robots_policy_note = excluded.robots_policy_note,
         crawl_run_id = excluded.crawl_run_id,
         fetched_at = excluded.fetched_at,
         last_seen_at = greatest(source_pages.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        input.url,
        input.urlCanonical,
        input.urlHash,
        input.domain,
        input.sourceType,
        input.httpStatus,
        input.contentHash,
        input.contentType,
        input.storageKey,
        input.robotsAllowed,
        input.robotsPolicyNote,
        input.crawlRunId,
        input.fetchedAt,
      ],
    );
    return requireId(result.rows[0], 'source_pages');
  }

  async recordObservation(input: ObservationInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into source_observations (
         source_page_id, crawl_run_id, entity_type, entity_id, record_key, field,
         value_raw, value_normalized, extraction_method, confidence, selector, observed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (source_page_id, record_key, field) do update set
         entity_id = coalesce(excluded.entity_id, source_observations.entity_id),
         value_raw = excluded.value_raw,
         value_normalized = excluded.value_normalized,
         confidence = greatest(source_observations.confidence, excluded.confidence),
         observed_at = excluded.observed_at
       returning id`,
      [
        input.sourcePageId,
        input.crawlRunId,
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
   * Insert or refresh one person, their assignment and their published addresses.
   *
   * The email insert deliberately never downgrades a stored classification: a
   * `decoded_published` row can be replaced by `published` when a later page
   * shows the address in plain text, but nothing moves in the other direction.
   */
  async ingestPerson(input: IngestPersonInput): Promise<IngestPersonResult> {
    const personResult = await this.client.query<{ id: Uuid; created: boolean }>(
      `insert into people (
         state_id, full_name_published, name_prefix, first_name, middle_name, last_name,
         name_suffix, identity_key, source_page_id, crawl_run_id, extraction_method,
         confidence, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       on conflict (state_id, identity_key) do update set
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
        input.stateId,
        input.fullNamePublished,
        input.nameParts.prefix,
        input.nameParts.firstName,
        input.nameParts.middleName,
        input.nameParts.lastName,
        input.nameParts.suffix,
        input.identityKey,
        input.sourcePageId,
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
         person_id, district_id, school_id, department_id, title_published, title_normalized,
         role_category, seniority, specialty, source_page_id, crawl_run_id, extraction_method,
         confidence, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       on conflict (person_id, district_id, school_id, title_normalized) do update set
         title_published = coalesce(excluded.title_published, employment_assignments.title_published),
         department_id = coalesce(excluded.department_id, employment_assignments.department_id),
         role_category = excluded.role_category,
         seniority = excluded.seniority,
         specialty = coalesce(excluded.specialty, employment_assignments.specialty),
         confidence = greatest(employment_assignments.confidence, excluded.confidence),
         first_seen_at = least(employment_assignments.first_seen_at, excluded.first_seen_at),
         last_seen_at = greatest(employment_assignments.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        personId,
        input.districtId,
        input.schoolId,
        input.departmentId,
        input.titlePublished,
        input.titleNormalized,
        input.roleCategory,
        input.seniority,
        input.specialty,
        input.sourcePageId,
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
           person_id, employment_assignment_id, district_id, school_id, address, address_normalized,
           domain, local_part, classification, obfuscation, source_value, source_page_id,
           crawl_run_id, extraction_method, confidence, first_seen_at, last_seen_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         on conflict (person_id, school_id, district_id, address_normalized) do update set
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
          input.districtId,
          input.schoolId,
          email.address,
          email.addressNormalized,
          email.domain,
          email.localPart,
          email.classification,
          email.obfuscation,
          email.sourceValue,
          input.sourcePageId,
          input.crawlRunId,
          input.extractionMethod,
          input.confidence,
          input.observedAt,
        ],
      );
      emailAddressIds.push(requireId(emailResult.rows[0], 'email_addresses'));
    }

    return {
      personId,
      employmentAssignmentId,
      emailAddressIds,
      personCreated: person?.created === true,
    };
  }
}

function requireId(row: { id?: Uuid } | undefined, table: string): Uuid {
  const id = row?.id;
  if (id === undefined) throw new Error(`${table}: upsert returned no id`);
  return id;
}
