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
  jurisdictionId: Uuid | null;
  websiteValueRaw: string | null;
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

export interface OrganizationSpineRelationshipSummary {
  materialized: number;
  unresolved: number;
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
         classification_review_reason, jurisdiction_id, website_value_raw,
         website_url, primary_domain,
         identifiers, parent_identifiers, location, attributes, status,
         source_document_id, source_document_version_id, source_effective_date,
         first_seen_at, last_seen_at
       )
       select input."sourceKey", input."sourceRecordKey", input.name, input."nameNormalized",
              input."organizationTypeCode", input."governmentLevelCode", input."sectorCode",
              input."classificationReviewReason", input."jurisdictionId", input."websiteValueRaw",
              input."websiteUrl", input."primaryDomain",
              input.identifiers, input."parentIdentifiers", input.location, input.attributes,
              input.status::organization_spine_record_status,
              input."sourceDocumentId", input."sourceDocumentVersionId",
              input."sourceEffectiveDate", input."observedAt", input."observedAt"
       from jsonb_to_recordset($1::jsonb) as input(
         "sourceKey" text, "sourceRecordKey" text, name text, "nameNormalized" text,
         "organizationTypeCode" text, "governmentLevelCode" text, "sectorCode" text,
         "classificationReviewReason" text, "jurisdictionId" uuid, "websiteValueRaw" text,
         "websiteUrl" text, "primaryDomain" text,
         identifiers jsonb, "parentIdentifiers" jsonb, location jsonb, attributes jsonb,
         status text, "sourceDocumentId" uuid, "sourceDocumentVersionId" uuid,
         "sourceEffectiveDate" date, "observedAt" timestamptz
       )
       on conflict (source_key, source_record_key, source_document_version_id) do update set
         name = excluded.name,
         name_normalized = excluded.name_normalized,
         organization_type_code = excluded.organization_type_code,
         government_level_code = excluded.government_level_code,
         sector_code = excluded.sector_code,
         classification_review_reason = excluded.classification_review_reason,
         jurisdiction_id = excluded.jurisdiction_id,
         website_value_raw = excluded.website_value_raw,
         website_url = excluded.website_url,
         primary_domain = excluded.primary_domain,
         identifiers = excluded.identifiers,
         parent_identifiers = excluded.parent_identifiers,
         location = excluded.location,
         attributes = excluded.attributes,
         status = case
           when organization_spine_records.status = 'imported' then 'imported'
           else excluded.status
         end,
         last_seen_at = greatest(
           organization_spine_records.last_seen_at, excluded.last_seen_at
         )
       returning id`,
      [JSON.stringify(records)],
    );
    return result.rows.length;
  }

  async canonicalizeReady(
    limit = 5_000,
    collectionScope?: { sourceKeys: readonly string[]; stateCodes: readonly string[] },
  ): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error('organization spine import limit must be between 1 and 5000');
    }
    return runAtomically(this.client, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext('organization_spine_identity'))");
      const selected = await tx.query<{ id: Uuid }>(
        `select id from organization_spine_records
         where organization_id is null and (
           ($2::boolean=false and status='ready_to_import') or
           ($2::boolean and source_key=any($3::text[]) and location->>'stateCode'=any($4::text[])
             and status in ('ready_to_import','classification_hold')
             and organization_type_code is not null and sector_code is not null and jsonb_array_length(identifiers)>0))
         order by source_key, source_record_key, id
         for update skip locked limit $1`,
        [
          limit,
          collectionScope !== undefined,
          collectionScope?.sourceKeys ?? [],
          collectionScope?.stateCodes ?? [],
        ],
      );
      let ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      let held = 0;
      const holdConflicts = async (rows: readonly { id: Uuid }[], reason: string) => {
        if (rows.length === 0) return;
        if (collectionScope === undefined) throw new Error(reason);
        const conflicts = rows.map((row) => row.id);
        await tx.query(
          `update organization_spine_records set organization_id=null,status='reconciliation_hold',
           classification_review_reason=concat_ws('; ',nullif(classification_review_reason,''),$2::text)
           where id=any($1::uuid[])`,
          [conflicts, reason],
        );
        const excluded = new Set(conflicts);
        ids = ids.filter((id) => !excluded.has(id));
        held += conflicts.length;
      };

      const ambiguous = await tx.query<{ id: Uuid }>(
        `select r.id
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.identifiers) identifier(item)
         join external_identifiers existing
           on existing.entity_type = 'organization'
          and existing.identifier_system_code = identifier.item ->> 'systemCode'
          and existing.issuing_state_code is not distinct from
            nullif(identifier.item ->> 'issuingStateCode', '')
          and existing.identifier_value = identifier.item ->> 'value'
         where r.id = any($1::uuid[])
         group by r.id having count(distinct existing.entity_id) > 1`,
        [ids],
      );
      await holdConflicts(
        ambiguous.rows,
        'organization spine identifiers resolve to conflicting organizations',
      );
      if (ids.length === 0) return held;

      await tx.query(
        `update organization_spine_records r set organization_id = matched.entity_id
         from (
           select r.id, (array_agg(distinct existing.entity_id))[1] as entity_id
           from organization_spine_records r
           cross join lateral jsonb_array_elements(r.identifiers) identifier(item)
           join external_identifiers existing
             on existing.entity_type = 'organization'
            and existing.identifier_system_code = identifier.item ->> 'systemCode'
            and existing.issuing_state_code is not distinct from
              nullif(identifier.item ->> 'issuingStateCode', '')
            and existing.identifier_value = identifier.item ->> 'value'
           where r.id = any($1::uuid[])
           group by r.id
         ) matched
         where r.id = matched.id`,
        [ids],
      );

      const classificationConflict = await tx.query<{ id: Uuid }>(
        `select r.id
         from organization_spine_records r
         join organizations organization on organization.id = r.organization_id
         where r.id = any($1::uuid[])
           and (
             organization.organization_type_code <> r.organization_type_code
             or organization.government_level_code <> r.government_level_code
             or organization.sector_code <> r.sector_code
             or (
               organization.jurisdiction_id is not null
               and r.jurisdiction_id is not null
               and organization.jurisdiction_id <> r.jurisdiction_id
             )
           )`,
        [ids],
      );
      await holdConflicts(
        classificationConflict.rows,
        'organization spine exact match has conflicting classification',
      );
      if (ids.length === 0) return held;

      await tx.query(
        `insert into organizations (
           organization_type_code, government_level_code, sector_code,
           jurisdiction_id, name, name_normalized, name_source_value, website_url, primary_domain,
           identity_tier, identity_fingerprint, needs_identity_review,
           source_document_id, extraction_method_code, confidence,
           first_seen_at, last_seen_at
         )
         select r.organization_type_code, r.government_level_code, r.sector_code,
                r.jurisdiction_id, r.name, r.name_normalized, r.name, r.website_url, r.primary_domain,
                'official_identifier',
                'oid:' || (r.identifiers -> 0 ->> 'systemCode') || ':' ||
                  case
                    when nullif(r.identifiers -> 0 ->> 'issuingStateCode', '') is null then ''
                    else (r.identifiers -> 0 ->> 'issuingStateCode') || ':'
                  end || (r.identifiers -> 0 ->> 'value'),
                false, r.source_document_id, 'bulk_import', 1,
                r.first_seen_at, r.last_seen_at
         from organization_spine_records r
         where r.id = any($1::uuid[]) and r.organization_id is null
         on conflict (identity_fingerprint) do update set
           website_url = coalesce(organizations.website_url, excluded.website_url),
           primary_domain = coalesce(organizations.primary_domain, excluded.primary_domain),
           jurisdiction_id = coalesce(organizations.jurisdiction_id, excluded.jurisdiction_id),
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
               case
                 when nullif(r.identifiers -> 0 ->> 'issuingStateCode', '') is null then ''
                 else (r.identifiers -> 0 ->> 'issuingStateCode') || ':'
               end || (r.identifiers -> 0 ->> 'value')`,
        [ids],
      );

      await tx.query(
        `update organizations organization set
           website_url = coalesce(organization.website_url, r.website_url),
           primary_domain = coalesce(organization.primary_domain, r.primary_domain),
           jurisdiction_id = coalesce(organization.jurisdiction_id, r.jurisdiction_id),
           confidence = greatest(organization.confidence, 1),
           last_seen_at = greatest(organization.last_seen_at, r.last_seen_at)
         from organization_spine_records r
         where r.id = any($1::uuid[]) and r.organization_id = organization.id`,
        [ids],
      );

      const identifierConflict = await tx.query<{ id: Uuid }>(
        `select r.id
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.identifiers) identifier(item)
         join external_identifiers existing
           on existing.identifier_system_code = identifier.item ->> 'systemCode'
          and existing.issuing_state_code is not distinct from
            nullif(identifier.item ->> 'issuingStateCode', '')
          and existing.identifier_value = identifier.item ->> 'value'
         where r.id = any($1::uuid[])
           and (existing.entity_type <> 'organization' or existing.entity_id <> r.organization_id)
         limit 1`,
        [ids],
      );
      if (identifierConflict.rows[0] !== undefined) {
        throw new Error('organization spine identifier is already claimed by another entity');
      }

      await tx.query(
        `insert into external_identifiers (
           entity_type, entity_id, identifier_system_code, identifier_value,
           issuing_state_code, is_primary, source_document_id,
           extraction_method_code, confidence, first_seen_at, last_seen_at
         )
         select 'organization', r.organization_id,
                identifier.item ->> 'systemCode', identifier.item ->> 'value',
                nullif(identifier.item ->> 'issuingStateCode', ''),
                identifier.ordinality = 1 and not exists (
                  select 1 from external_identifiers primary_identifier
                  where primary_identifier.entity_type = 'organization'
                    and primary_identifier.entity_id = r.organization_id
                    and primary_identifier.is_primary
                ), r.source_document_id,
                'bulk_import', 1, r.first_seen_at, r.last_seen_at
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.identifiers)
           with ordinality as identifier(item, ordinality)
         where r.id = any($1::uuid[]) and r.organization_id is not null
         on conflict (identifier_system_code, issuing_state_code, identifier_value) do update set
           last_seen_at = greatest(external_identifiers.last_seen_at, excluded.last_seen_at)
         where external_identifiers.entity_type = excluded.entity_type
           and external_identifiers.entity_id = excluded.entity_id`,
        [ids],
      );
      const postInsertConflict = await tx.query<{ id: Uuid }>(
        `select r.id
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.identifiers) identifier(item)
         join external_identifiers existing
           on existing.identifier_system_code = identifier.item ->> 'systemCode'
          and existing.issuing_state_code is not distinct from
            nullif(identifier.item ->> 'issuingStateCode', '')
          and existing.identifier_value = identifier.item ->> 'value'
         where r.id = any($1::uuid[])
           and (existing.entity_type <> 'organization' or existing.entity_id <> r.organization_id)
         limit 1`,
        [ids],
      );
      if (postInsertConflict.rows[0] !== undefined) {
        throw new Error('organization spine batch contains a conflicting exact identifier');
      }
      await tx.query(
        `insert into source_observations (
           source_document_version_id, evidence_class, entity_type, entity_id,
           record_key, field, value_raw, value_normalized,
           extraction_method_code, confidence, observed_at
         )
         select r.source_document_version_id, 'organization', 'organization', r.organization_id,
                r.source_key || ':' || r.source_record_key, observation.field,
                observation.value_raw, observation.value_normalized,
                'bulk_import', 1, r.last_seen_at
         from organization_spine_records r
         cross join lateral (values
           ('name', r.name, r.name_normalized),
           ('website_url', r.website_value_raw, r.website_url)
         ) observation(field, value_raw, value_normalized)
         where r.id = any($1::uuid[]) and r.organization_id is not null
           and observation.value_raw is not null
         on conflict (source_document_version_id, record_key, field) do nothing`,
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
        `update organization_spine_records set status = case when government_level_code is null or classification_review_reason is not null then 'classification_hold'::organization_spine_record_status else 'imported'::organization_spine_record_status end
         where id = any($1::uuid[]) and organization_id is not null
         returning id`,
        [ids],
      );
      return imported.rows.length + held;
    });
  }

  async materializeRelationships(
    sourceKey?: string,
  ): Promise<OrganizationSpineRelationshipSummary> {
    return runAtomically(this.client, async (tx) => {
      const conflicts = await tx.query<{ id: Uuid }>(
        `select r.id
         from organization_spine_records r
         cross join lateral jsonb_array_elements(r.parent_identifiers) parent(item)
         join external_identifiers identifier
           on identifier.entity_type = 'organization'
          and identifier.identifier_system_code = parent.item ->> 'systemCode'
          and identifier.issuing_state_code is not distinct from
            nullif(parent.item ->> 'issuingStateCode', '')
          and identifier.identifier_value = parent.item ->> 'value'
         where r.organization_id is not null
           and ($1::text is null or r.source_key = $1)
         group by r.id having count(distinct identifier.entity_id) > 1
         limit 1`,
        [sourceKey ?? null],
      );
      if (conflicts.rows[0] !== undefined) {
        throw new Error(
          'organization spine parent identifiers resolve to conflicting organizations',
        );
      }

      const materialized = await tx.query<{ id: Uuid }>(
        `insert into organization_relationships (
           parent_organization_id, child_organization_id, relationship_type_code,
           effective_from, source_document_id, extraction_method_code, confidence,
           first_seen_at, last_seen_at
         )
         select resolved.parent_id, r.organization_id, 'part_of',
                coalesce(r.source_effective_date, r.first_seen_at::date),
                r.source_document_id, 'bulk_import', 1, r.first_seen_at, r.last_seen_at
         from organization_spine_records r
         cross join lateral (
           select (array_agg(distinct identifier.entity_id))[1] as parent_id
           from jsonb_array_elements(r.parent_identifiers) parent(item)
           join external_identifiers identifier
             on identifier.entity_type = 'organization'
            and identifier.identifier_system_code = parent.item ->> 'systemCode'
            and identifier.issuing_state_code is not distinct from
              nullif(parent.item ->> 'issuingStateCode', '')
            and identifier.identifier_value = parent.item ->> 'value'
         ) resolved
         where r.organization_id is not null
           and jsonb_array_length(r.parent_identifiers) > 0
           and resolved.parent_id is not null
           and resolved.parent_id <> r.organization_id
           and ($1::text is null or r.source_key = $1)
         on conflict (
           parent_organization_id, child_organization_id,
           relationship_type_code, effective_from
         ) do update set
           confidence = greatest(organization_relationships.confidence, excluded.confidence),
           last_seen_at = greatest(organization_relationships.last_seen_at, excluded.last_seen_at)
         returning id`,
        [sourceKey ?? null],
      );

      const unresolved = await tx.query<{ count: number }>(
        `select count(*)::int as count
         from organization_spine_records r
         where r.organization_id is not null
           and jsonb_array_length(r.parent_identifiers) > 0
           and ($1::text is null or r.source_key = $1)
           and not exists (
             select 1
             from jsonb_array_elements(r.parent_identifiers) parent(item)
             join external_identifiers identifier
               on identifier.entity_type = 'organization'
              and identifier.identifier_system_code = parent.item ->> 'systemCode'
              and identifier.issuing_state_code is not distinct from
                nullif(parent.item ->> 'issuingStateCode', '')
              and identifier.identifier_value = parent.item ->> 'value'
           )`,
        [sourceKey ?? null],
      );
      return {
        materialized: materialized.rows.length,
        unresolved: Number(unresolved.rows[0]?.count ?? 0),
      };
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
