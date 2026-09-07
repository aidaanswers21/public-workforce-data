import type { Uuid } from '@public-workforce/shared-types';
import { runAtomically, type SqlClient } from '../client.js';

export type WebsiteAvailability = 'all' | 'published' | 'missing';

export interface OrganizationRecordFilters {
  organizationTypeCodes: readonly string[];
  sectorCodes: readonly string[];
  sourceKeys: readonly string[];
  stateCode?: string | null;
  query?: string;
  websiteAvailability?: WebsiteAvailability;
  limit?: number;
  offset?: number;
}

export interface OrganizationSourceRecord {
  id: Uuid;
  sourceKey: string;
  sourceRecordKey: string;
  name: string;
  organizationTypeCode: string | null;
  governmentLevelCode: string | null;
  sectorCode: string | null;
  classificationReviewReason: string | null;
  websiteUrl: string | null;
  identifiers: readonly Record<string, unknown>[];
  parentIdentifiers: readonly Record<string, unknown>[];
  location: Readonly<Record<string, unknown>>;
  attributes: Readonly<Record<string, unknown>>;
  status: string;
  organizationId: Uuid | null;
  sourceEffectiveDate: string | null;
  sourceUrl: string;
  sourceVersion: number;
  sourceContentHash: string;
  sourceRetrievedAt: string;
}

export interface OrganizationRecordPage {
  records: OrganizationSourceRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProjectSourceRecordSelection {
  selected: number;
  crawlReady: number;
  held: number;
}

/** Read-only source-record exploration plus explicit, non-executing project selection. */
export class OrganizationRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async list(filters: OrganizationRecordFilters): Promise<OrganizationRecordPage> {
    const limit = integerInRange(filters.limit ?? 100, 1, 250, 'page size');
    const offset = integerInRange(filters.offset ?? 0, 0, 10_000_000, 'offset');
    const query = filters.query?.trim() ?? '';
    const websiteAvailability = filters.websiteAvailability ?? 'all';
    if (!['all', 'published', 'missing'].includes(websiteAvailability)) {
      throw new Error('website availability is not valid');
    }
    if (
      filters.organizationTypeCodes.length === 0 ||
      filters.sectorCodes.length === 0 ||
      filters.sourceKeys.length === 0
    ) {
      return { records: [], total: 0, limit, offset };
    }
    const result = await this.client.query<Record<string, unknown>>(
      `${SOURCE_RECORD_SELECT}, count(*) over()::int as total
       from organization_spine_records r
       join source_documents d on d.id = r.source_document_id
       join source_document_versions v on v.id = r.source_document_version_id
       where r.organization_type_code = any($1::text[])
         and r.sector_code = any($2::text[])
         and r.source_key = any($3::text[])
         and ($4::text is null or r.location ->> 'stateCode' = $4)
         and ($5::text = '' or r.name ilike '%' || $5 || '%'
              or r.source_record_key ilike '%' || $5 || '%')
         and ($6::text = 'all'
              or ($6 = 'published' and r.website_url is not null)
              or ($6 = 'missing' and r.website_url is null))
       order by r.name_normalized, r.id
       limit $7 offset $8`,
      [
        [...filters.organizationTypeCodes],
        [...filters.sectorCodes],
        [...filters.sourceKeys],
        filters.stateCode || null,
        query,
        websiteAvailability,
        limit,
        offset,
      ],
    );
    return {
      records: result.rows.map(mapRecord),
      total: Number(result.rows[0]?.['total'] ?? 0),
      limit,
      offset,
    };
  }

  async get(id: Uuid): Promise<OrganizationSourceRecord | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `${SOURCE_RECORD_SELECT}
       from organization_spine_records r
       join source_documents d on d.id = r.source_document_id
       join source_document_versions v on v.id = r.source_document_version_id
       where r.id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapRecord(result.rows[0]);
  }

  async addToProject(
    projectId: Uuid,
    recordIds: readonly Uuid[],
    actor: string,
  ): Promise<ProjectSourceRecordSelection> {
    const uniqueIds = [...new Set(recordIds)];
    if (uniqueIds.length === 0) throw new Error('select at least one organization record');
    if (uniqueIds.length > 250) throw new Error('select no more than 250 organization records');

    return runAtomically(this.client, async (tx) => {
      const project = await tx.query<Record<string, unknown>>(
        `select state_code, sector_codes, status
         from collection_projects where id = $1 for update`,
        [projectId],
      );
      const projectRow = project.rows[0];
      if (projectRow === undefined) throw new Error('collection project not found');
      if (['completed', 'cancelled'].includes(String(projectRow['status']))) {
        throw new Error('this collection project no longer accepts selections');
      }

      const records = await tx.query<Record<string, unknown>>(
        `select id, sector_code, location, organization_id, status
         from organization_spine_records where id = any($1::uuid[])`,
        [uniqueIds],
      );
      if (records.rows.length !== uniqueIds.length) {
        throw new Error('one or more organization records were not found');
      }
      const sectors = new Set(stringArray(projectRow['sector_codes']));
      const stateCode = nullableString(projectRow['state_code']);
      for (const record of records.rows) {
        const sectorCode = nullableString(record['sector_code']);
        const location = objectValue(record['location']);
        if (sectorCode !== null && !sectors.has(sectorCode)) {
          throw new Error('the selected record is outside this project sector');
        }
        if (stateCode !== null && location['stateCode'] !== stateCode) {
          throw new Error('the selected record is outside this project state');
        }
      }

      await tx.query(
        `insert into collection_project_source_records (
           project_id, source_record_id, added_by
         ) select $1, selected_id, $3
           from unnest($2::uuid[]) as selected_id
         on conflict (project_id, source_record_id) do nothing`,
        [projectId, uniqueIds, actor],
      );
      await tx.query(
        `insert into collection_project_organizations (
           project_id, organization_id, selection_reason
         ) select $1, r.organization_id, 'explicit source record selection'
           from organization_spine_records r
          where r.id = any($2::uuid[]) and r.organization_id is not null
         on conflict (project_id, organization_id) do nothing`,
        [projectId, uniqueIds],
      );
      const crawlReady = records.rows.filter((row) => row['organization_id'] !== null).length;
      await tx.query('select audit_event_append($1,$2,$3,$4,$5)', [
        actor,
        'collection_project.source_records_selected',
        'collection_project',
        projectId,
        JSON.stringify({ selected: uniqueIds.length, crawlReady }),
      ]);
      return { selected: uniqueIds.length, crawlReady, held: uniqueIds.length - crawlReady };
    });
  }
}

const SOURCE_RECORD_SELECT = `select
  r.id, r.source_key, r.source_record_key, r.name, r.organization_type_code,
  r.government_level_code, r.sector_code, r.classification_review_reason,
  r.website_url, r.identifiers, r.parent_identifiers, r.location, r.attributes,
  r.status, r.organization_id, r.source_effective_date,
  d.url as source_url, v.version as source_version,
  v.content_hash as source_content_hash, v.retrieved_at as source_retrieved_at`;

function mapRecord(row: Record<string, unknown>): OrganizationSourceRecord {
  return {
    id: String(row['id']),
    sourceKey: String(row['source_key']),
    sourceRecordKey: String(row['source_record_key']),
    name: String(row['name']),
    organizationTypeCode: nullableString(row['organization_type_code']),
    governmentLevelCode: nullableString(row['government_level_code']),
    sectorCode: nullableString(row['sector_code']),
    classificationReviewReason: nullableString(row['classification_review_reason']),
    websiteUrl: nullableString(row['website_url']),
    identifiers: arrayOfObjects(row['identifiers']),
    parentIdentifiers: arrayOfObjects(row['parent_identifiers']),
    location: objectValue(row['location']),
    attributes: objectValue(row['attributes']),
    status: String(row['status']),
    organizationId: nullableString(row['organization_id']),
    sourceEffectiveDate: dateString(row['source_effective_date']),
    sourceUrl: String(row['source_url']),
    sourceVersion: Number(row['source_version']),
    sourceContentHash: String(row['source_content_hash']),
    sourceRetrievedAt: new Date(String(row['source_retrieved_at'])).toISOString(),
  };
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? null;
}

function dateString(value: unknown): string | null {
  const text = nullableString(value);
  return text === null ? null : text.slice(0, 10);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
