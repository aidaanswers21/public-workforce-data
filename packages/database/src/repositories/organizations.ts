import type {
  ExtractionMethod,
  OrganizationIdentityTier,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
import { runAtomically, type SqlClient } from '../client.js';

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

export class OrganizationIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationIdentityConflictError';
  }
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
      const stateScope = input.identifier.issuingStateCode;
      return {
        tier: 'official_identifier',
        fingerprint:
          stateScope == null
            ? `oid:${input.identifier.systemCode}:${input.identifier.value}`
            : `oid:${input.identifier.systemCode}:${stateScope}:${input.identifier.value}`,
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
   * Each exact tier fingerprint is retained as evidence. A recrawl can therefore
   * resolve an organization after stronger evidence replaced its canonical
   * fingerprint, without falling back to a name-only match.
   */
  async upsertOrganization(
    input: UpsertOrganizationInput,
  ): Promise<{ id: Uuid; created: boolean; identity: OrganizationIdentity }> {
    return runAtomically(this.client, async (tx) => {
      const scoped = new OrganizationRepository(tx);
      return scoped.upsertOrganizationInTransaction(input);
    });
  }

  private async upsertOrganizationInTransaction(
    input: UpsertOrganizationInput,
  ): Promise<{ id: Uuid; created: boolean; identity: OrganizationIdentity }> {
    const candidates = this.identityCandidates(input);
    const proposed = candidates[0] as OrganizationIdentity;
    for (const fingerprint of candidates.map((candidate) => candidate.fingerprint).sort()) {
      await this.client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        fingerprint,
      ]);
    }

    const owners = new Set<Uuid>();
    const addOwner = (owner: Uuid | null): void => {
      if (owner !== null) owners.add(owner);
    };

    if (input.identifier != null) {
      addOwner(
        await this.identifierOwner(
          input.identifier.systemCode,
          input.identifier.value,
          input.identifier.issuingStateCode ?? null,
        ),
      );
    }
    if (input.sourceIdentifier != null) {
      addOwner(
        await this.evidenceOwner(
          'source_identifier',
          input.sourceIdentifier.system,
          input.sourceIdentifier.value,
        ),
      );
    }
    for (const candidate of candidates) {
      addOwner(await this.fingerprintOwner(candidate.fingerprint));
      addOwner(
        await this.evidenceOwner('identity_fingerprint', candidate.tier, candidate.fingerprint),
      );
    }

    if (owners.size > 1) {
      throw new OrganizationIdentityConflictError(
        'incoming organization evidence points to conflicting existing organizations',
      );
    }

    let id = [...owners][0] ?? null;
    let created = false;
    if (id === null) {
      const inserted = await this.client.query<{ id: Uuid }>(
        `insert into organizations (
           organization_type_code, government_level_code, sector_code, jurisdiction_id, name,
           name_normalized, name_source_value, legal_name, short_name, website_url,
           primary_domain, email_domains, source_document_id, crawl_run_id,
           extraction_method_code, confidence, first_seen_at, last_seen_at,
           identity_tier, identity_fingerprint, needs_identity_review, identity_review_reason
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20,$21
         ) returning id`,
        organizationParameters(input, proposed),
      );
      id = requireId(inserted.rows[0], 'organizations');
      created = true;
    } else {
      const stored = await this.client.query<{
        identity_tier: OrganizationIdentityTier;
        identity_fingerprint: string;
        needs_identity_review: boolean;
        identity_review_reason: string | null;
        source_document_id: Uuid;
        last_seen_at: Timestamp;
      }>(
        `select identity_tier, identity_fingerprint, needs_identity_review,
                identity_review_reason, source_document_id, last_seen_at
         from organizations where id = $1`,
        [id],
      );
      const current = stored.rows[0];
      if (current === undefined) throw new Error('organizations: identity owner disappeared');
      const effective = strongerIdentity(
        {
          tier: current.identity_tier,
          fingerprint: current.identity_fingerprint,
          needsReview: current.needs_identity_review,
          reviewReason: current.identity_review_reason,
        },
        proposed,
      );
      const acceptCanonicalValues =
        identityRank(proposed.tier) >= identityRank(current.identity_tier);
      await this.recordFingerprintEvidence(
        id,
        {
          tier: current.identity_tier,
          fingerprint: current.identity_fingerprint,
          needsReview: current.needs_identity_review,
          reviewReason: current.identity_review_reason,
        },
        current.source_document_id,
        current.last_seen_at,
      );
      await this.client.query(
        `update organizations set
           organization_type_code = case when $23 then $2 else organization_type_code end,
           government_level_code = case when $23 then $3 else government_level_code end,
           sector_code = case when $23 then $4 else sector_code end,
           jurisdiction_id = case when $23 then coalesce($5, jurisdiction_id) else jurisdiction_id end,
           name = case when $23 and $17::timestamptz >= last_seen_at then $6 else name end,
           name_normalized = case when $23 and $17::timestamptz >= last_seen_at then $7 else name_normalized end,
           name_source_value = case when $23 then coalesce($8, name_source_value) else name_source_value end,
           legal_name = case when $23 then coalesce($9, legal_name) else legal_name end,
           short_name = case when $23 then coalesce($10, short_name) else short_name end,
           website_url = case when $23 then coalesce($11, website_url) else website_url end,
           primary_domain = case when $23 then coalesce($12, primary_domain) else primary_domain end,
           email_domains = case when $23 and cardinality($13::text[]) > 0 then $13 else email_domains end,
           source_document_id = case when $23 then $14 else source_document_id end,
           crawl_run_id = case when $23 then coalesce($15, crawl_run_id) else crawl_run_id end,
           extraction_method_code = case when $23 then $16 else extraction_method_code end,
           confidence = case when $23 then greatest(confidence, $18) else confidence end,
           last_seen_at = greatest(last_seen_at, $17),
           identity_tier = $19,
           identity_fingerprint = $20,
           needs_identity_review = $21,
           identity_review_reason = $22
         where id = $1`,
        [
          id,
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
          input.observedAt,
          input.confidence,
          effective.tier,
          effective.fingerprint,
          effective.needsReview,
          effective.reviewReason,
          acceptCanonicalValues,
        ],
      );
    }

    if (input.identifier != null) {
      const different = await this.client.query<{ identifier_value: string }>(
        `select identifier_value from external_identifiers
         where entity_type = 'organization' and entity_id = $1
           and identifier_system_code = $2
           and issuing_state_code is not distinct from $4
           and identifier_value <> $3
         limit 1`,
        [
          id,
          input.identifier.systemCode,
          input.identifier.value,
          input.identifier.issuingStateCode ?? null,
        ],
      );
      if (different.rows[0] !== undefined) {
        throw new OrganizationIdentityConflictError(
          `organization already has a different ${input.identifier.systemCode} identifier`,
        );
      }
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

    await this.recordIdentityEvidence(id, input, candidates);
    const finalIdentity = await this.organizationIdentity(id);
    return { id, created, identity: finalIdentity };
  }

  private async identifierOwner(
    system: string,
    value: string,
    issuingStateCode: string | null,
  ): Promise<Uuid | null> {
    const result = await this.client.query<{ entity_id: Uuid }>(
      `select entity_id from external_identifiers
       where entity_type = 'organization' and identifier_system_code = $1
         and issuing_state_code is not distinct from $3
         and identifier_value = $2`,
      [system, value, issuingStateCode],
    );
    return result.rows[0]?.entity_id ?? null;
  }

  private async evidenceOwner(
    type: string,
    system: string | null,
    value: string,
  ): Promise<Uuid | null> {
    const result = await this.client.query<{ organization_id: Uuid }>(
      `select distinct organization_id from organization_identity_evidence
       where evidence_type = $1 and evidence_system is not distinct from $2
         and evidence_value_normalized = $3
       order by organization_id limit 2`,
      [type, system, normalizeEvidence(value)],
    );
    if (result.rows.length > 1) {
      throw new OrganizationIdentityConflictError(
        `${type} ${system ?? ''}:${value} belongs to more than one organization`,
      );
    }
    return result.rows[0]?.organization_id ?? null;
  }

  private async fingerprintOwner(fingerprint: string): Promise<Uuid | null> {
    const result = await this.client.query<{ id: Uuid }>(
      `select id from organizations where identity_fingerprint = $1`,
      [fingerprint],
    );
    return result.rows[0]?.id ?? null;
  }

  private identityCandidates(input: UpsertOrganizationInput): OrganizationIdentity[] {
    const variants: UpsertOrganizationInput[] = [input];
    if (input.identifier != null) variants.push({ ...input, identifier: null });
    if (input.sourceIdentifier != null) {
      variants.push({ ...input, identifier: null, sourceIdentifier: null });
    }
    const candidates = new Map<string, OrganizationIdentity>();
    for (const variant of variants) {
      const identity = this.resolveIdentity(variant);
      candidates.set(identity.fingerprint, identity);
    }
    return [...candidates.values()];
  }

  private async recordIdentityEvidence(
    id: Uuid,
    input: UpsertOrganizationInput,
    identities: readonly OrganizationIdentity[],
  ): Promise<void> {
    const evidence: [string, string | null, string][] = [['name', null, input.name]];
    if (input.identifier != null) {
      evidence.push(['official_identifier', input.identifier.systemCode, input.identifier.value]);
    }
    if (input.sourceIdentifier != null) {
      evidence.push([
        'source_identifier',
        input.sourceIdentifier.system,
        input.sourceIdentifier.value,
      ]);
    }
    const source = await this.client.query<{ url_canonical: string }>(
      `select url_canonical from source_documents where id = $1`,
      [input.sourceDocumentId],
    );
    const sourceUrl = source.rows[0]?.url_canonical;
    if (sourceUrl !== undefined) evidence.push(['source_url', null, sourceUrl]);
    for (const identity of identities) {
      evidence.push(['identity_fingerprint', identity.tier, identity.fingerprint]);
    }

    for (const [type, system, value] of evidence) {
      await this.client.query(
        `insert into organization_identity_evidence (
           organization_id, evidence_type, evidence_system, evidence_value,
           evidence_value_normalized, source_document_id, first_seen_at, last_seen_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$7)
         on conflict (
           organization_id, evidence_type, evidence_system,
           evidence_value_normalized, source_document_id
         ) do update set last_seen_at = greatest(
           organization_identity_evidence.last_seen_at, excluded.last_seen_at
         )`,
        [
          id,
          type,
          system,
          value,
          normalizeEvidence(value),
          input.sourceDocumentId,
          input.observedAt,
        ],
      );
    }
  }

  private async recordFingerprintEvidence(
    id: Uuid,
    identity: OrganizationIdentity,
    sourceDocumentId: Uuid,
    observedAt: Timestamp,
  ): Promise<void> {
    await this.client.query(
      `insert into organization_identity_evidence (
         organization_id, evidence_type, evidence_system, evidence_value,
         evidence_value_normalized, source_document_id, first_seen_at, last_seen_at
       ) values ($1,'identity_fingerprint',$2,$3,$4,$5,$6,$6)
       on conflict (
         organization_id, evidence_type, evidence_system,
         evidence_value_normalized, source_document_id
       ) do update set last_seen_at = greatest(
         organization_identity_evidence.last_seen_at, excluded.last_seen_at
       )`,
      [
        id,
        identity.tier,
        identity.fingerprint,
        normalizeEvidence(identity.fingerprint),
        sourceDocumentId,
        observedAt,
      ],
    );
  }

  private async organizationIdentity(id: Uuid): Promise<OrganizationIdentity> {
    const result = await this.client.query<{
      identity_tier: OrganizationIdentityTier;
      identity_fingerprint: string;
      needs_identity_review: boolean;
      identity_review_reason: string | null;
    }>(
      `select identity_tier, identity_fingerprint, needs_identity_review,
              identity_review_reason from organizations where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('organizations: identity lookup returned no row');
    return {
      tier: row.identity_tier,
      fingerprint: row.identity_fingerprint,
      needsReview: row.needs_identity_review,
      reviewReason: row.identity_review_reason,
    };
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
    return runAtomically(this.client, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(734878942635191127)');
      const result = await tx.query<{ id: Uuid }>(
        `insert into organization_relationships (
         parent_organization_id, child_organization_id, relationship_type_code, effective_from,
         effective_to, notes, source_document_id, crawl_run_id, extraction_method_code, confidence,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (parent_organization_id, child_organization_id, relationship_type_code, effective_from)
       do update set
         effective_to = case
           when organization_relationships.effective_to is null then excluded.effective_to
           else organization_relationships.effective_to
         end,
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
    });
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
       on conflict (identifier_system_code, issuing_state_code, identifier_value) do update set
         is_primary = excluded.is_primary or external_identifiers.is_primary,
         last_seen_at = greatest(external_identifiers.last_seen_at, excluded.last_seen_at)
       where external_identifiers.entity_type = excluded.entity_type
         and external_identifiers.entity_id = excluded.entity_id
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
    const row = result.rows[0];
    if (row === undefined) {
      throw new OrganizationIdentityConflictError(
        `${input.identifierSystemCode}:${input.issuingStateCode ?? '-'}:` +
          `${input.identifierValue} is already claimed by another entity`,
      );
    }
    return row.id;
  }
}

function organizationParameters(
  input: UpsertOrganizationInput,
  identity: OrganizationIdentity,
): readonly unknown[] {
  return [
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
  ];
}

function strongerIdentity(
  stored: OrganizationIdentity,
  incoming: OrganizationIdentity,
): OrganizationIdentity {
  return identityRank(incoming.tier) > identityRank(stored.tier) ? incoming : stored;
}

function identityRank(tier: OrganizationIdentityTier): number {
  switch (tier) {
    case 'official_identifier':
      return 4;
    case 'source_identifier':
      return 3;
    case 'parent_scoped_name':
      return 2;
    case 'domain_scoped_name':
      return 1;
    case 'ambiguous':
      return 0;
  }
}

function normalizeEvidence(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
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
