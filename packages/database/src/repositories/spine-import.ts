import { runAtomically, type SqlClient } from '../client.js';
import type { OrganizationSpineRecordStatus, Uuid } from '@public-workforce/shared-types';

export interface StageOrganizationSpineRecord {
  sourceKey: string;
  sourceRecordKey: string;
  name: string;
  nameNormalized: string;
  organizationTypeCode: string | null;
  governmentLevelCode: string | null;
  sectorCode: string | null;
  classificationReviewReason: string | null;
  websiteUrl: string | null;
  primaryDomain: string | null;
  identifiers: readonly {
    systemCode: string;
    value: string;
    issuingStateCode: string | null;
  }[];
  parentIdentifiers: readonly {
    systemCode: string;
    value: string;
    issuingStateCode: string | null;
  }[];
  location: Readonly<Record<string, string | number | boolean | null>>;
  attributes: Readonly<Record<string, string | number | boolean | null>>;
  status: OrganizationSpineRecordStatus;
  sourceDocumentId: Uuid;
  sourceDocumentVersionId: Uuid;
  sourceEffectiveDate: string | null;
  observedAt: string;
}

export interface OrganizationSpineDatabaseSummary {
  staged: number;
  readyToImport: number;
  imported: number;
  classificationHolds: number;
  overlayHolds: number;
  reconciliationHolds: number;
  failed: number;
}

/** Durable, provenance-bearing handoff from bulk source files to canonical rows. */
export class OrganizationSpineImportRepository {
  constructor(private readonly client: SqlClient) {}

  async stage(records: readonly StageOrganizationSpineRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    if (records.length > 5_000) throw new Error('organization spine stage batch exceeds 5000 rows');
    const result = await this.client.query<{ id: Uuid }>(
      `insert into organization_spine_records (
         source_key, source_record_key, name, name_normalized,
         organization_type_code, government_level_code, sector_code,
         classification_review_reason, website_url, primary_domain,
         identifiers, parent_identifiers, location, attributes, status,
         source_document_id, source_document_version_id, source_effective_date,
         first_seen_at, last_seen_at
       )
       select input."sourceKey", input."sourceRecordKey", input.name, input."nameNormalized",
              input."organizationTypeCode", input."governmentLevelCode", input."sectorCode",
              input."classificationReviewReason", input."websiteUrl", input."primaryDomain",
              input.identifiers, input."parentIdentifiers", input.location, input.attributes,
              input.status::organization_spine_record_status,
              input."sourceDocumentId", input."sourceDocumentVersionId",
              input."sourceEffectiveDate", input."observedAt", input."observedAt"
       from jsonb_to_recordset($1::jsonb) as input(
         "sourceKey" text, "sourceRecordKey" text, name text, "nameNormalized" text,
         "organizationTypeCode" text, "governmentLevelCode" text, "sectorCode" text,
         "classificationReviewReason" text, "websiteUrl" text, "primaryDomain" text,
         identifiers jsonb, "parentIdentifiers" jsonb, location jsonb, attributes jsonb,
         status text, "sourceDocumentId" uuid, "sourceDocumentVersionId" uuid,
         "sourceEffectiveDate" date, "observedAt" timestamptz
       )
       on conflict (source_key, source_record_key, source_document_version_id) do update set
         last_seen_at = greatest(
           organization_spine_records.last_seen_at, excluded.last_seen_at
         )
       returning id`,
      [JSON.stringify(records)],
    );
    return result.rows.length;
  }

  async canonicalizeReady(limit = 5_000): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error('organization spine import limit must be between 1 and 5000');
    }
    return runAtomically(this.client, async (tx) => {
      const selected = await tx.query<{ id: Uuid }>(
        `select id from organization_spine_records
         where status = 'ready_to_import' and organization_id is null
         order by source_key, source_record_key, id
         for update skip locked limit $1`,
        [limit],
      );
      const ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;

      await tx.query(
        `insert into organizations (
           organization_type_code, government_level_code, sector_code,
           name, name_normalized, name_source_value, website_url, primary_domain,
           identity_tier, identity_fingerprint, needs_identity_review,
           source_document_id, extraction_method_code, confidence,
           first_seen_at, last_seen_at
         )
         select r.organization_type_code, r.government_level_code, r.sector_code,
                r.name, r.name_normalized, r.name, r.website_url, r.primary_domain,
                'official_identifier',
                'oid:' || (r.identifiers -> 0 ->> 'systemCode') || ':' ||
                  (r.identifiers -> 0 ->> 'value'),
                false, r.source_document_id, 'bulk_import', 1,
                r.first_seen_at, r.last_seen_at
         from organization_spine_records r where r.id = any($1::uuid[])
         on conflict (identity_fingerprint) do update set
           website_url = coalesce(organizations.website_url, excluded.website_url),
           primary_domain = coalesce(organizations.primary_domain, excluded.primary_domain),
           confidence = greatest(organizations.confidence, excluded.confidence),
           last_seen_at = greatest(organizations.last_seen_at, excluded.last_seen_at)`,
        [ids],
      );
      await tx.query(
        `update organization_spine_records r set organization_id = o.id
         from organizations o
         where r.id = any($1::uuid[])
           and o.identity_fingerprint =
             'oid:' || (r.identifiers -> 0 ->> 'systemCode') || ':' ||
               (r.identifiers -> 0 ->> 'value')`,
        [ids],
      );
      await tx.query(
        `insert into external_identifiers (
           entity_type, entity_id, identifier_system_code, identifier_value,
           issuing_state_code, is_primary, source_document_id,
           extraction_method_code, confidence, first_seen_at, last_seen_at
         )
         select 'organization', r.organization_id,
                identifier.item ->> 'systemCode', identifier.item ->> 'value',
                nullif(identifier.item ->> 'issuingStateCode', ''),
                identifier.ordinality = 1, r.source_document_id,
                'bulk_import', 1, r.first_seen_at, r.last_seen_at
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.identifiers)
           with ordinality as identifier(item, ordinality)
         where r.id = any($1::uuid[]) and r.organization_id is not null
         on conflict (identifier_system_code, identifier_value) do update set
           last_seen_at = greatest(external_identifiers.last_seen_at, excluded.last_seen_at)
         where external_identifiers.entity_type = excluded.entity_type
           and external_identifiers.entity_id = excluded.entity_id`,
        [ids],
      );
      await tx.query(
        `insert into organization_locations (
           organization_id, address_line1, address_line2, city, state_code,
           postal_code, is_primary, source_document_id, extraction_method_code,
           confidence, first_seen_at, last_seen_at
         )
         select r.organization_id, r.location ->> 'addressLine1',
                r.location ->> 'addressLine2', r.location ->> 'city',
                nullif(r.location ->> 'stateCode', ''), r.location ->> 'postalCode',
                true, r.source_document_id, 'bulk_import', 1,
                r.first_seen_at, r.last_seen_at
         from organization_spine_records r
         where r.id = any($1::uuid[]) and r.organization_id is not null
           and exists (
             select 1 from jsonb_each_text(r.location) location_value
             where nullif(location_value.value, '') is not null
           )
           and not exists (
             select 1 from organization_locations location
             where location.organization_id = r.organization_id
               and location.source_document_id = r.source_document_id
               and location.address_line1 is not distinct from r.location ->> 'addressLine1'
               and location.address_line2 is not distinct from r.location ->> 'addressLine2'
               and location.city is not distinct from r.location ->> 'city'
               and location.state_code is not distinct from nullif(r.location ->> 'stateCode', '')
               and location.postal_code is not distinct from r.location ->> 'postalCode'
           )`,
        [ids],
      );
      const imported = await tx.query<{ id: Uuid }>(
        `update organization_spine_records set status = 'imported'
         where id = any($1::uuid[]) and organization_id is not null
         returning id`,
        [ids],
      );
      return imported.rows.length;
    });
  }

  async summary(): Promise<OrganizationSpineDatabaseSummary> {
    const result = await this.client.query<Record<string, unknown>>(
      `select count(*)::int as staged,
              count(*) filter (where status = 'ready_to_import')::int as ready_to_import,
              count(*) filter (where status = 'imported')::int as imported,
              count(*) filter (where status = 'classification_hold')::int as classification_holds,
              count(*) filter (where status = 'overlay_hold')::int as overlay_holds,
              count(*) filter (where status = 'reconciliation_hold')::int
                as reconciliation_holds,
              count(*) filter (where status = 'failed')::int as failed
       from organization_spine_records`,
    );
    const row = result.rows[0] ?? {};
    return {
      staged: Number(row['staged'] ?? 0),
      readyToImport: Number(row['ready_to_import'] ?? 0),
      imported: Number(row['imported'] ?? 0),
      classificationHolds: Number(row['classification_holds'] ?? 0),
      overlayHolds: Number(row['overlay_holds'] ?? 0),
      reconciliationHolds: Number(row['reconciliation_holds'] ?? 0),
      failed: Number(row['failed'] ?? 0),
    };
  }
}
