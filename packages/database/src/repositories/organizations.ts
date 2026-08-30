import type { ExtractionMethod, Timestamp, Uuid } from '@pan/shared-types';
import type { SqlClient } from '../client.js';

export interface UpsertGeographicAreaInput {
  areaTypeCode: string;
  name: string;
  nameNormalized: string;
  parentAreaId?: Uuid | null;
  stateCode?: string | null;
}

export interface UpsertJurisdictionInput {
  code: string;
  name: string;
  governmentLevelCode: string;
  geographicAreaId?: Uuid | null;
  parentJurisdictionId?: Uuid | null;
}

export interface UpsertOrganizationInput {
  organizationTypeCode: string;
  governmentLevelCode: string;
  sectorCode: string;
  jurisdictionId?: Uuid | null;
  name: string;
  nameNormalized: string;
  nameSourceValue?: string | null;
  legalName?: string | null;
  shortName?: string | null;
  websiteUrl?: string | null;
  primaryDomain?: string | null;
  emailDomains?: readonly string[];
  sourceDocumentId: Uuid;
  crawlRunId?: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  observedAt: Timestamp;
  /** Official identifier to key on, when one exists. Preferred over the name. */
  identifier?: { systemCode: string; value: string; issuingStateCode?: string | null } | null;
}

export interface UpsertRelationshipInput {
  parentOrganizationId: Uuid;
  childOrganizationId: Uuid;
  relationshipTypeCode: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
  sourceDocumentId: Uuid;
  crawlRunId?: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  observedAt: Timestamp;
}

/**
 * Reads and writes the neutral organization model.
 *
 * Every method here works the same for a federal bureau, a county department
 * and a school. Where a vertical needs more, it adds an extension table keyed
 * to `organizations.id` rather than a column on this one.
 */
export class OrganizationRepository {
  constructor(private readonly client: SqlClient) {}

  async upsertGeographicArea(input: UpsertGeographicAreaInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into geographic_areas (area_type_code, name, name_normalized, parent_area_id, state_code)
       values ($1,$2,$3,$4,$5)
       on conflict (area_type_code, name_normalized, parent_area_id) do update set
         name = excluded.name,
         state_code = coalesce(excluded.state_code, geographic_areas.state_code),
         updated_at = now()
       returning id`,
      [
        input.areaTypeCode,
        input.name,
        input.nameNormalized,
        input.parentAreaId ?? null,
        input.stateCode ?? null,
      ],
    );
    return requireId(result.rows[0], 'geographic_areas');
  }

  async upsertJurisdiction(input: UpsertJurisdictionInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into jurisdictions (code, name, government_level_code, geographic_area_id, parent_jurisdiction_id)
       values ($1,$2,$3,$4,$5)
       on conflict (code) do update set
         name = excluded.name,
         government_level_code = excluded.government_level_code,
         geographic_area_id = coalesce(excluded.geographic_area_id, jurisdictions.geographic_area_id),
         parent_jurisdiction_id = coalesce(excluded.parent_jurisdiction_id, jurisdictions.parent_jurisdiction_id),
         updated_at = now()
       returning id`,
      [
        input.code,
        input.name,
        input.governmentLevelCode,
        input.geographicAreaId ?? null,
        input.parentJurisdictionId ?? null,
      ],
    );
    return requireId(result.rows[0], 'jurisdictions');
  }

  /**
   * Insert or refresh an organization.
   *
   * When an official identifier is supplied it is the key, because names change
   * and identifiers do not. Without one, the fallback is type plus normalized
   * name plus jurisdiction, which is weaker and is why the importer is the
   * preferred path for institution lists.
   */
  async upsertOrganization(
    input: UpsertOrganizationInput,
  ): Promise<{ id: Uuid; created: boolean }> {
    if (input.identifier != null) {
      const existing = await this.client.query<{ entity_id: Uuid }>(
        `select entity_id from external_identifiers
         where identifier_system_code = $1 and identifier_value = $2 and entity_type = 'organization'`,
        [input.identifier.systemCode, input.identifier.value],
      );
      const existingId = existing.rows[0]?.entity_id;
      if (existingId !== undefined) {
        await this.refreshOrganization(existingId, input);
        return { id: existingId, created: false };
      }
    }

    const result = await this.client.query<{ id: Uuid; created: boolean }>(
      `insert into organizations (
         organization_type_code, government_level_code, sector_code, jurisdiction_id, name,
         name_normalized, name_source_value, legal_name, short_name, website_url, primary_domain,
         email_domains, source_document_id, crawl_run_id, extraction_method, confidence,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
       returning id, true as created`,
      [
        input.organizationTypeCode,
        input.governmentLevelCode,
        input.sectorCode,
        input.jurisdictionId ?? null,
        input.name,
        input.nameNormalized,
        input.nameSourceValue ?? null,
        input.legalName ?? null,
        input.shortName ?? null,
        input.websiteUrl ?? null,
        input.primaryDomain ?? null,
        [...(input.emailDomains ?? [])],
        input.sourceDocumentId,
        input.crawlRunId ?? null,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    const id = requireId(result.rows[0], 'organizations');

    if (input.identifier != null) {
      await this.upsertExternalIdentifier({
        entityType: 'organization',
        entityId: id,
        identifierSystemCode: input.identifier.systemCode,
        identifierValue: input.identifier.value,
        issuingStateCode: input.identifier.issuingStateCode ?? null,
        isPrimary: true,
        sourceDocumentId: input.sourceDocumentId,
        crawlRunId: input.crawlRunId ?? null,
        extractionMethod: input.extractionMethod,
        confidence: input.confidence,
        observedAt: input.observedAt,
      });
    }

    return { id, created: true };
  }

  private async refreshOrganization(id: Uuid, input: UpsertOrganizationInput): Promise<void> {
    await this.client.query(
      `update organizations set
         name = case when length($2) > length(name) then $2 else name end,
         website_url = coalesce($3, website_url),
         primary_domain = coalesce($4, primary_domain),
         confidence = greatest(confidence, $5),
         last_seen_at = greatest(last_seen_at, $6::timestamptz)
       where id = $1`,
      [
        id,
        input.name,
        input.websiteUrl ?? null,
        input.primaryDomain ?? null,
        input.confidence,
        input.observedAt,
      ],
    );
  }

  async upsertRelationship(input: UpsertRelationshipInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into organization_relationships (
         parent_organization_id, child_organization_id, relationship_type_code, effective_from,
         effective_to, notes, source_document_id, crawl_run_id, extraction_method, confidence,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (parent_organization_id, child_organization_id, relationship_type_code, effective_from)
       do update set
         effective_to = excluded.effective_to,
         notes = coalesce(excluded.notes, organization_relationships.notes),
         confidence = greatest(organization_relationships.confidence, excluded.confidence),
         last_seen_at = greatest(organization_relationships.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        input.parentOrganizationId,
        input.childOrganizationId,
        input.relationshipTypeCode,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.notes ?? null,
        input.sourceDocumentId,
        input.crawlRunId ?? null,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    return requireId(result.rows[0], 'organization_relationships');
  }

  /**
   * Every organization above this one, following only containment relationships.
   *
   * Oversight and succession do not count: a body that once succeeded another
   * should not inherit its opt-outs. Depth is bounded so a cycle in the source
   * data cannot hang the query.
   */
  async ancestorsOf(organizationId: Uuid, asOf?: string): Promise<Uuid[]> {
    const result = await this.client.query<{ ancestor_id: Uuid; depth: number }>(
      `with recursive ancestors as (
         select $1::uuid as ancestor_id, 0 as depth
         union all
         select r.parent_organization_id, a.depth + 1
         from ancestors a
         join organization_relationships r on r.child_organization_id = a.ancestor_id
         join relationship_types rt on rt.code = r.relationship_type_code and rt.implies_subtree
         where a.depth < 12
           and r.effective_from <= coalesce($2::date, current_date)
           and (r.effective_to is null or r.effective_to >= coalesce($2::date, current_date))
       )
       select distinct ancestor_id, min(depth) as depth
       from ancestors where depth > 0
       group by ancestor_id order by depth`,
      [organizationId, asOf ?? null],
    );
    return result.rows.map((row) => row.ancestor_id);
  }

  /** Everything below an organization, used for coverage and subtree reporting. */
  async descendantsOf(organizationId: Uuid, asOf?: string): Promise<Uuid[]> {
    const result = await this.client.query<{ descendant_id: Uuid }>(
      `with recursive descendants as (
         select $1::uuid as descendant_id, 0 as depth
         union all
         select r.child_organization_id, d.depth + 1
         from descendants d
         join organization_relationships r on r.parent_organization_id = d.descendant_id
         join relationship_types rt on rt.code = r.relationship_type_code and rt.implies_subtree
         where d.depth < 12
           and r.effective_from <= coalesce($2::date, current_date)
           and (r.effective_to is null or r.effective_to >= coalesce($2::date, current_date))
       )
       select distinct descendant_id from descendants where depth > 0`,
      [organizationId, asOf ?? null],
    );
    return result.rows.map((row) => row.descendant_id);
  }

  async upsertUnit(input: {
    organizationId: Uuid;
    parentUnitId?: Uuid | null;
    name: string;
    nameNormalized: string;
    nameSourceValue?: string | null;
    sourceDocumentId: Uuid;
    crawlRunId?: Uuid | null;
    extractionMethod: ExtractionMethod;
    confidence: number;
    observedAt: Timestamp;
  }): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into organizational_units (
         organization_id, parent_unit_id, name, name_normalized, name_source_value,
         source_document_id, crawl_run_id, extraction_method, confidence, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       on conflict (organization_id, parent_unit_id, name_normalized) do update set
         name = excluded.name,
         confidence = greatest(organizational_units.confidence, excluded.confidence),
         last_seen_at = greatest(organizational_units.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        input.organizationId,
        input.parentUnitId ?? null,
        input.name,
        input.nameNormalized,
        input.nameSourceValue ?? null,
        input.sourceDocumentId,
        input.crawlRunId ?? null,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    return requireId(result.rows[0], 'organizational_units');
  }

  async upsertLocation(input: {
    organizationId: Uuid;
    locationType?: string;
    name?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    stateCode?: string | null;
    postalCode?: string | null;
    geographicAreaId?: Uuid | null;
    isPrimary?: boolean;
    sourceDocumentId: Uuid;
    crawlRunId?: Uuid | null;
    extractionMethod: ExtractionMethod;
    confidence: number;
    observedAt: Timestamp;
  }): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into organization_locations (
         organization_id, location_type, name, address_line1, city, state_code, postal_code,
         geographic_area_id, is_primary, source_document_id, crawl_run_id, extraction_method,
         confidence, first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       returning id`,
      [
        input.organizationId,
        input.locationType ?? 'office',
        input.name ?? null,
        input.addressLine1 ?? null,
        input.city ?? null,
        input.stateCode ?? null,
        input.postalCode ?? null,
        input.geographicAreaId ?? null,
        input.isPrimary ?? false,
        input.sourceDocumentId,
        input.crawlRunId ?? null,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    return requireId(result.rows[0], 'organization_locations');
  }

  async upsertExternalIdentifier(input: {
    entityType: 'organization' | 'geographic_area' | 'jurisdiction' | 'person';
    entityId: Uuid;
    identifierSystemCode: string;
    identifierValue: string;
    issuingStateCode?: string | null;
    isPrimary?: boolean;
    sourceDocumentId: Uuid;
    crawlRunId?: Uuid | null;
    extractionMethod: ExtractionMethod;
    confidence: number;
    observedAt: Timestamp;
  }): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into external_identifiers (
         entity_type, entity_id, identifier_system_code, identifier_value, issuing_state_code,
         is_primary, source_document_id, crawl_run_id, extraction_method, confidence,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (identifier_system_code, identifier_value) do update set
         is_primary = excluded.is_primary or external_identifiers.is_primary,
         last_seen_at = greatest(external_identifiers.last_seen_at, excluded.last_seen_at)
       returning id`,
      [
        input.entityType,
        input.entityId,
        input.identifierSystemCode,
        input.identifierValue,
        input.issuingStateCode ?? null,
        input.isPrimary ?? false,
        input.sourceDocumentId,
        input.crawlRunId ?? null,
        input.extractionMethod,
        input.confidence,
        input.observedAt,
      ],
    );
    return requireId(result.rows[0], 'external_identifiers');
  }
}

function requireId(row: { id?: Uuid } | undefined, table: string): Uuid {
  const id = row?.id;
  if (id === undefined) throw new Error(`${table}: upsert returned no id`);
  return id;
}
