import type {
  ExtractionMethod,
  OrganizationIdentityTier,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
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
  /**
   * A key the source itself assigns and keeps stable between publications.
   *
   * Not an official identifier: a row id in a directory API, a slug in a URL, a
   * campus number in a spreadsheet. Weaker than an official identifier and much
   * stronger than a name, and it is what makes an identifier-less recrawl land
   * on the same row.
   */
  sourceIdentifier?: { system: string; value: string } | null;
  /**
   * The organization this one sits inside, when the source says so.
   *
   * Two schools called "Lincoln Elementary" in two districts are two
   * organizations, so the parent is part of the identity rather than a detail
   * recorded afterwards.
   */
  parentOrganizationId?: Uuid | null;
}

/** How an organization was identified, and whether a person needs to look. */
export interface OrganizationIdentity {
  tier: OrganizationIdentityTier;
  fingerprint: string;
  needsReview: boolean;
  reviewReason: string | null;
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
   * Resolve which organization a source record is about.
   *
   * Five tiers, strongest evidence first. The tier that fires becomes part of
   * the stored fingerprint, so a record identified by an official identifier
   * can never collide with one identified by a name, and two records identified
   * the same way collide only when they really are the same body.
   *
   *   1. An official identifier. Names change; identifiers do not.
   *   2. A stable key the source assigns. Weaker, and still exact.
   *   3. Type, normalized name, containing parent and jurisdiction. This is why
   *      the parent is part of the key: two "Lincoln Elementary" schools in two
   *      districts are two schools, and a key without the parent would merge
   *      them. That is the specific merge this design exists to prevent.
   *   4. With no parent: type, normalized name, jurisdiction and stable domain
   *      evidence. A city's own domain distinguishes its Parks Department from
   *      the next city's.
   *   5. Nothing left to distinguish them. The record is kept, keyed on the
   *      source record itself so a recrawl is still idempotent, and flagged for
   *      a person. It is never merged into a look-alike and never duplicated.
   */
  resolveIdentity(input: UpsertOrganizationInput): OrganizationIdentity {
    const jurisdiction = input.jurisdictionId ?? '-';
    const type = input.organizationTypeCode;
    const name = input.nameNormalized;

    if (input.identifier != null) {
      return {
        tier: 'official_identifier',
        fingerprint: `oid:${input.identifier.systemCode}:${input.identifier.value}`,
        needsReview: false,
        reviewReason: null,
      };
    }
    if (input.sourceIdentifier != null) {
      return {
        tier: 'source_identifier',
        fingerprint: `sid:${input.sourceIdentifier.system}:${input.sourceIdentifier.value}`,
        needsReview: false,
        reviewReason: null,
      };
    }
    if (input.parentOrganizationId != null) {
      return {
        tier: 'parent_scoped_name',
        fingerprint: `psn:${jurisdiction}:${input.parentOrganizationId}:${type}:${name}`,
        needsReview: false,
        reviewReason: null,
      };
    }
    const domain = input.primaryDomain ?? domainOf(input.websiteUrl ?? null);
    if (domain !== null && input.jurisdictionId != null) {
      return {
        tier: 'domain_scoped_name',
        fingerprint: `dsn:${jurisdiction}:${domain}:${type}:${name}`,
        needsReview: false,
        reviewReason: null,
      };
    }

    // Nothing above the name. Keyed on the source record so the next crawl of
    // the same page finds this row again rather than adding a second one.
    return {
      tier: 'ambiguous',
      fingerprint: `amb:${input.sourceDocumentId}:${type}:${name}`,
      needsReview: true,
      reviewReason:
        domain === null && input.jurisdictionId == null
          ? 'no official identifier, no source identifier, no parent, no jurisdiction and no domain'
          : domain === null
            ? 'no official identifier, no source identifier, no parent and no domain evidence'
            : 'no official identifier, no source identifier, no parent and no jurisdiction',
    };
  }

  /**
   * Insert or refresh an organization.
   *
   * Idempotent by construction: `resolveIdentity` produces the same fingerprint
   * for the same source record every time, and the fingerprint is unique, so a
   * recrawl updates rather than duplicates whether or not an identifier exists.
   */
  async upsertOrganization(
    input: UpsertOrganizationInput,
  ): Promise<{ id: Uuid; created: boolean; identity: OrganizationIdentity }> {
    const identity = this.resolveIdentity(input);

    const result = await this.client.query<{ id: Uuid; created: boolean }>(
      `insert into organizations (
         organization_type_code, government_level_code, sector_code, jurisdiction_id, name,
         name_normalized, name_source_value, legal_name, short_name, website_url, primary_domain,
         email_domains, source_document_id, crawl_run_id, extraction_method_code, confidence,
         first_seen_at, last_seen_at,
         identity_tier, identity_fingerprint, needs_identity_review, identity_review_reason
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20,$21)
       on conflict (identity_fingerprint) do update set
         name = case
           when length(excluded.name) > length(organizations.name) then excluded.name
           else organizations.name
         end,
         website_url = coalesce(excluded.website_url, organizations.website_url),
         primary_domain = coalesce(excluded.primary_domain, organizations.primary_domain),
         jurisdiction_id = coalesce(organizations.jurisdiction_id, excluded.jurisdiction_id),
         confidence = greatest(organizations.confidence, excluded.confidence),
         last_seen_at = greatest(organizations.last_seen_at, excluded.last_seen_at)
       returning id, (xmax = 0) as created`,
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
        identity.tier,
        identity.fingerprint,
        identity.needsReview,
        identity.reviewReason,
      ],
    );
    const id = requireId(result.rows[0], 'organizations');
    const created = result.rows[0]?.created ?? false;

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

    return { id, created, identity };
  }

  /** Organizations whose identity a person still has to confirm. */
  async identityReviewQueue(
    limit = 50,
  ): Promise<{ id: Uuid; name: string; tier: string; reason: string | null }[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, name, identity_tier, identity_review_reason
       from organizations where needs_identity_review
       order by first_seen_at limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row['id'] as Uuid,
      name: row['name'] as string,
      tier: row['identity_tier'] as string,
      reason: (row['identity_review_reason'] as string | null) ?? null,
    }));
  }

  async upsertRelationship(input: UpsertRelationshipInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into organization_relationships (
         parent_organization_id, child_organization_id, relationship_type_code, effective_from,
         effective_to, notes, source_document_id, crawl_run_id, extraction_method_code, confidence,
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
         source_document_id, crawl_run_id, extraction_method_code, confidence, first_seen_at, last_seen_at
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
         geographic_area_id, is_primary, source_document_id, crawl_run_id, extraction_method_code,
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
         is_primary, source_document_id, crawl_run_id, extraction_method_code, confidence,
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

/** The host of a URL, or null. Kept local: this is identity, not normalization. */
function domainOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
