import { canonicalizeUrl, domainOf } from '@public-workforce/core';
import { runAtomically, type SqlClient } from '../client.js';
import type {
  OrganizationWebsiteCandidateStatus,
  Timestamp,
  Uuid,
  WebsiteResolutionMethod,
} from '@public-workforce/shared-types';

export interface MissingWebsiteQueueInput {
  limit?: number;
  afterId?: Uuid | null;
  governmentLevelCodes?: readonly string[];
  sectorCodes?: readonly string[];
  stateCodes?: readonly string[];
  organizationTypeCodes?: readonly string[];
}

export interface MissingWebsiteOrganization {
  id: Uuid;
  name: string;
  organizationTypeCode: string;
  governmentLevelCode: string;
  sectorCode: string;
  jurisdictionId: Uuid | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  identifiers: { systemCode: string; value: string; issuingStateCode: string | null }[];
  proposedCandidates: number;
  bestCandidateConfidence: number | null;
}

export type WebsiteMatchSignals = Readonly<Record<string, string | number | boolean | null>>;

export interface RecordWebsiteCandidateInput {
  organizationId: Uuid;
  url: string;
  resolutionMethod: WebsiteResolutionMethod;
  matchSignals: WebsiteMatchSignals;
  confidence: number;
  sourceDocumentId: Uuid;
  sourceDocumentVersionId: Uuid;
  observedAt: Timestamp;
}

export interface WebsiteCandidate {
  id: Uuid;
  organizationId: Uuid;
  url: string;
  primaryDomain: string;
  resolutionMethod: WebsiteResolutionMethod;
  status: OrganizationWebsiteCandidateStatus;
  matchSignals: WebsiteMatchSignals;
  confidence: number;
  sourceDocumentId: Uuid;
  sourceDocumentVersionId: Uuid;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface ReviewWebsiteCandidateInput {
  candidateId: Uuid;
  reviewedBy: string;
  reviewNote: string;
  reviewedAt: Timestamp;
}

/**
 * Durable website resolution separated from directory discovery.
 *
 * The queue is derived from canonical organization rows with no published
 * website. Candidate URLs remain evidence-bearing proposals until a person
 * verifies one. This prevents a search result or name match from becoming an
 * official organization website merely because it scored well.
 */
export class WebsiteResolutionRepository {
  constructor(private readonly client: SqlClient) {}

  async missingWebsiteQueue(
    input: MissingWebsiteQueueInput = {},
  ): Promise<MissingWebsiteOrganization[]> {
    const limit = input.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error('website resolution queue limit must be between 1 and 5000');
    }
    const result = await this.client.query<Record<string, unknown>>(
      `select o.id, o.name, o.organization_type_code, o.government_level_code,
              o.sector_code, o.jurisdiction_id,
              location.city, location.state_code, location.postal_code,
              coalesce(identifiers.items, '[]'::jsonb) as identifiers,
              coalesce(candidates.proposed_count, 0)::int as proposed_candidates,
              candidates.best_confidence
       from organizations o
       left join lateral (
         select l.city, l.state_code, l.postal_code
         from organization_locations l
         where l.organization_id = o.id
         order by l.is_primary desc, l.first_seen_at, l.id
         limit 1
       ) location on true
       left join lateral (
         select jsonb_agg(
                  jsonb_build_object(
                    'systemCode', e.identifier_system_code,
                    'value', e.identifier_value,
                    'issuingStateCode', e.issuing_state_code
                  )
                  order by e.is_primary desc, e.identifier_system_code,
                           e.issuing_state_code, e.identifier_value
                ) as items
         from external_identifiers e
         where e.entity_type = 'organization' and e.entity_id = o.id
       ) identifiers on true
       left join lateral (
         select count(*) filter (where c.status = 'proposed') as proposed_count,
                max(c.confidence) filter (where c.status = 'proposed') as best_confidence
         from organization_website_candidates c
         where c.organization_id = o.id
       ) candidates on true
       where o.website_url is null and o.status = 'active'
         and ($1::uuid is null or o.id > $1)
         and (cardinality($2::text[]) = 0 or o.government_level_code = any($2::text[]))
         and (cardinality($3::text[]) = 0 or o.sector_code = any($3::text[]))
         and (cardinality($4::text[]) = 0 or location.state_code = any($4::text[]))
         and (cardinality($5::text[]) = 0 or o.organization_type_code = any($5::text[]))
       order by o.id
       limit $6`,
      [
        input.afterId ?? null,
        [...(input.governmentLevelCodes ?? [])],
        [...(input.sectorCodes ?? [])],
        [...(input.stateCodes ?? [])],
        [...(input.organizationTypeCodes ?? [])],
        limit,
      ],
    );
    return result.rows.map(mapMissingWebsiteOrganization);
  }

  async recordCandidate(input: RecordWebsiteCandidateInput): Promise<WebsiteCandidate> {
    if (input.confidence < 0 || input.confidence > 1) {
      throw new Error('website candidate confidence must be between 0 and 1');
    }
    const url = canonicalizeWebsite(input.url);
    const primaryDomain = domainOf(url);
    if (primaryDomain === null) throw new Error('website candidate has no usable domain');
    const result = await this.client.query<Record<string, unknown>>(
      `insert into organization_website_candidates (
         organization_id, url, primary_domain, resolution_method, match_signals,
         confidence, source_document_id, source_document_version_id,
         first_seen_at, last_seen_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       on conflict (organization_id, url) do update set
         match_signals = case
           when organization_website_candidates.status = 'proposed'
             then excluded.match_signals
           else organization_website_candidates.match_signals
         end,
         confidence = case
           when organization_website_candidates.status = 'proposed'
             then greatest(organization_website_candidates.confidence, excluded.confidence)
           else organization_website_candidates.confidence
         end,
         last_seen_at = greatest(organization_website_candidates.last_seen_at, excluded.last_seen_at)
       returning *`,
      [
        input.organizationId,
        url,
        primaryDomain,
        input.resolutionMethod,
        JSON.stringify(input.matchSignals),
        input.confidence,
        input.sourceDocumentId,
        input.sourceDocumentVersionId,
        input.observedAt,
      ],
    );
    return mapCandidate(requiredRow(result.rows[0], 'website candidate'));
  }

  async listCandidates(organizationId: Uuid): Promise<WebsiteCandidate[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select * from organization_website_candidates
       where organization_id = $1
       order by case status when 'verified' then 0 when 'proposed' then 1 else 2 end,
                confidence desc, first_seen_at`,
      [organizationId],
    );
    return result.rows.map(mapCandidate);
  }

  async verifyCandidate(input: ReviewWebsiteCandidateInput): Promise<WebsiteCandidate> {
    validateReview(input);
    return runAtomically(this.client, async (tx) => {
      const selected = await tx.query<Record<string, unknown>>(
        `select * from organization_website_candidates where id = $1 for update`,
        [input.candidateId],
      );
      const candidate = mapCandidate(requiredRow(selected.rows[0], 'website candidate'));
      if (candidate.status !== 'proposed') {
        throw new Error(`website candidate is already ${candidate.status}`);
      }
      const organization = await tx.query<{ website_url: string | null }>(
        `select website_url from organizations where id = $1 for update`,
        [candidate.organizationId],
      );
      const currentWebsite = organization.rows[0]?.website_url;
      if (currentWebsite === undefined) throw new Error('organization not found');
      if (currentWebsite !== null) {
        throw new Error('organization already has a canonical website');
      }

      await tx.query(
        `update organization_website_candidates set
           status = 'verified', reviewed_by = $2, reviewed_at = $3, review_note = $4
         where id = $1`,
        [input.candidateId, input.reviewedBy.trim(), input.reviewedAt, input.reviewNote.trim()],
      );
      await tx.query(
        `update organizations set
           website_url = $2,
           primary_domain = $3,
           source_document_id = $4,
           extraction_method_code = 'manual',
           confidence = greatest(confidence, $5),
           last_seen_at = greatest(last_seen_at, $6)
         where id = $1`,
        [
          candidate.organizationId,
          candidate.url,
          candidate.primaryDomain,
          candidate.sourceDocumentId,
          candidate.confidence,
          input.reviewedAt,
        ],
      );
      await tx.query(
        `select audit_event_append($1, 'organization.website_verified', 'organization', $2, $3)`,
        [
          input.reviewedBy.trim(),
          candidate.organizationId,
          JSON.stringify({
            candidateId: candidate.id,
            url: candidate.url,
            resolutionMethod: candidate.resolutionMethod,
          }),
        ],
      );
      return {
        ...candidate,
        status: 'verified',
        reviewedBy: input.reviewedBy.trim(),
        reviewedAt: input.reviewedAt,
        reviewNote: input.reviewNote.trim(),
      };
    });
  }

  async rejectCandidate(input: ReviewWebsiteCandidateInput): Promise<WebsiteCandidate> {
    validateReview(input);
    const result = await this.client.query<Record<string, unknown>>(
      `update organization_website_candidates set
         status = 'rejected', reviewed_by = $2, reviewed_at = $3, review_note = $4
       where id = $1 and status = 'proposed'
       returning *`,
      [input.candidateId, input.reviewedBy.trim(), input.reviewedAt, input.reviewNote.trim()],
    );
    return mapCandidate(requiredRow(result.rows[0], 'proposed website candidate'));
  }
}

function canonicalizeWebsite(value: string): string {
  const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  const canonical = canonicalizeUrl(withScheme);
  if (canonical === null) throw new Error('website candidate is not a usable HTTP URL');
  return canonical;
}

function validateReview(input: ReviewWebsiteCandidateInput): void {
  if (input.reviewedBy.trim().length === 0) throw new Error('reviewer is required');
  if (input.reviewNote.trim().length < 8) {
    throw new Error('website review note must explain the decision');
  }
}

function requiredRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`${label} not found`);
  return row;
}

function jsonObject(value: unknown): WebsiteMatchSignals {
  if (typeof value === 'string') return JSON.parse(value) as WebsiteMatchSignals;
  return (value ?? {}) as WebsiteMatchSignals;
}

function jsonArray(
  value: unknown,
): { systemCode: string; value: string; issuingStateCode: string | null }[] {
  if (typeof value === 'string')
    return JSON.parse(value) as {
      systemCode: string;
      value: string;
      issuingStateCode: string | null;
    }[];
  return (value ?? []) as {
    systemCode: string;
    value: string;
    issuingStateCode: string | null;
  }[];
}

function mapMissingWebsiteOrganization(row: Record<string, unknown>): MissingWebsiteOrganization {
  return {
    id: String(row['id']),
    name: String(row['name']),
    organizationTypeCode: String(row['organization_type_code']),
    governmentLevelCode: String(row['government_level_code']),
    sectorCode: String(row['sector_code']),
    jurisdictionId: optionalString(row['jurisdiction_id']),
    city: optionalString(row['city']),
    stateCode: optionalString(row['state_code']),
    postalCode: optionalString(row['postal_code']),
    identifiers: jsonArray(row['identifiers']),
    proposedCandidates: Number(row['proposed_candidates'] ?? 0),
    bestCandidateConfidence: row['best_confidence'] == null ? null : Number(row['best_confidence']),
  };
}

function mapCandidate(row: Record<string, unknown>): WebsiteCandidate {
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    url: String(row['url']),
    primaryDomain: String(row['primary_domain']),
    resolutionMethod: String(row['resolution_method']) as WebsiteResolutionMethod,
    status: String(row['status']) as OrganizationWebsiteCandidateStatus,
    matchSignals: jsonObject(row['match_signals']),
    confidence: Number(row['confidence']),
    sourceDocumentId: String(row['source_document_id']),
    sourceDocumentVersionId: String(row['source_document_version_id']),
    reviewedBy: optionalString(row['reviewed_by']),
    reviewedAt:
      row['reviewed_at'] == null ? null : new Date(scalarString(row['reviewed_at'])).toISOString(),
    reviewNote: optionalString(row['review_note']),
  };
}

function optionalString(value: unknown): string | null {
  return value == null ? null : scalarString(value);
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error('database returned a non-scalar value');
}
