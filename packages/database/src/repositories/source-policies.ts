import { createHash } from 'node:crypto';
import type {
  CollectionStatus,
  PolicyStance,
  SourcePolicyRecord,
  Uuid,
} from '@public-workforce/shared-types';
import { runAtomically, type SqlClient } from '../client.js';

export interface RecordSourcePolicyReviewInput {
  domain?: string | null;
  urlPattern?: string | null;
  sourceTypeCode?: string | null;
  collectionStatus: CollectionStatus;
  commercialUseStatus: PolicyStance;
  solicitationStatus: PolicyStance;
  automatedAccessStatus: PolicyStance;
  policyUrl?: string | null;
  policyTextSnapshot?: string | null;
  reviewNotes: string;
  reviewedBy: string;
}

/** Human source reviews and their separate production approvals. */
export class SourcePolicyRepository {
  constructor(private readonly client: SqlClient) {}

  async list(): Promise<SourcePolicyRecord[]> {
    const result = await this.client.query<Record<string, unknown>>(
      'select * from source_policies order by effective_at desc, created_at desc',
    );
    return result.rows.map(mapPolicy);
  }

  async recordReview(input: RecordSourcePolicyReviewInput): Promise<Uuid> {
    const domain = normalizeDomain(input.domain);
    const urlPattern = clean(input.urlPattern);
    const notes = input.reviewNotes.trim();
    const reviewer = input.reviewedBy.trim();
    if (domain === null && urlPattern === null)
      throw new Error('a domain or URL pattern is required');
    if (notes.length < 8) throw new Error('review notes must describe what the operator checked');
    if (reviewer.length === 0) throw new Error('reviewer identity is required');
    if (input.policyUrl !== null && input.policyUrl !== undefined) {
      const parsed = new URL(input.policyUrl);
      if (parsed.protocol !== 'https:') throw new Error('policy URL must use HTTPS');
    }
    if (urlPattern !== null) {
      try {
        new RegExp(urlPattern);
      } catch {
        throw new Error('URL pattern must be a valid regular expression');
      }
    }
    const snapshot = clean(input.policyTextSnapshot);
    const hash = snapshot === null ? null : createHash('sha256').update(snapshot).digest('hex');
    return runAtomically(this.client, async (tx) => {
      const result = await tx.query<{ id: Uuid }>(
        `insert into source_policies (
           domain, url_pattern, source_type_code, collection_status,
           commercial_use_status, solicitation_status, automated_access_status,
           policy_url, policy_text_snapshot, policy_text_hash,
           last_reviewed_at, reviewed_by, review_notes
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12)
         returning id`,
        [
          domain,
          urlPattern,
          input.sourceTypeCode ?? null,
          input.collectionStatus,
          input.commercialUseStatus,
          input.solicitationStatus,
          input.automatedAccessStatus,
          clean(input.policyUrl),
          snapshot,
          hash,
          reviewer,
          notes,
        ],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('source policy review insert returned no id');
      await appendAudit(tx, reviewer, 'source_policy.reviewed', id, {
        domain,
        urlPattern,
        collectionStatus: input.collectionStatus,
      });
      return id;
    });
  }

  async approve(id: Uuid, approvedBy: string, note: string): Promise<void> {
    const actor = approvedBy.trim();
    const approvalNote = note.trim();
    if (actor.length === 0) throw new Error('approver identity is required');
    if (approvalNote.length < 8)
      throw new Error('approval note must describe this source decision');
    await runAtomically(this.client, async (tx) => {
      const locked = await tx.query<{
        collection_status: CollectionStatus;
        reviewed_by: string | null;
        last_reviewed_at: string | null;
        production_approved_at: string | null;
      }>('select * from source_policies where id = $1 for update', [id]);
      const policy = locked.rows[0];
      if (policy === undefined) throw new Error('source policy not found');
      if (policy.collection_status === 'prohibited') {
        throw new Error('a prohibited source cannot be approved');
      }
      if (policy.reviewed_by === null || policy.last_reviewed_at === null) {
        throw new Error('the source must be reviewed before production approval');
      }
      if (policy.production_approved_at !== null)
        throw new Error('source policy is already approved');
      await tx.query(
        `update source_policies
         set production_approved_by = $2, production_approved_at = now(),
             production_approval_note = $3
         where id = $1`,
        [id, actor, approvalNote],
      );
      await appendAudit(tx, actor, 'source_policy.production_approved', id, {
        approvalNote,
      });
    });
  }
}

function normalizeDomain(value: string | null | undefined): string | null {
  const normalized =
    clean(value)
      ?.toLowerCase()
      .replace(/^www\./, '') ?? null;
  if (normalized === null) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.includes('..')) {
    throw new Error('domain is not valid');
  }
  return normalized;
}

function clean(value: string | null | undefined): string | null {
  const result = value?.trim() ?? '';
  return result.length === 0 ? null : result;
}

function mapPolicy(row: Record<string, unknown>): SourcePolicyRecord {
  const nullable = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return `${value}`;
    }
    throw new Error('source policy returned a non-scalar text value');
  };
  const iso = (value: unknown): string => new Date(String(value)).toISOString();
  return {
    id: String(row['id']),
    domain: nullable(row['domain']),
    urlPattern: nullable(row['url_pattern']),
    organizationId: nullable(row['organization_id']),
    jurisdictionId: nullable(row['jurisdiction_id']),
    sourceTypeCode: nullable(row['source_type_code']),
    collectionStatus: String(row['collection_status']) as CollectionStatus,
    commercialUseStatus: String(row['commercial_use_status']) as PolicyStance,
    solicitationStatus: String(row['solicitation_status']) as PolicyStance,
    automatedAccessStatus: String(row['automated_access_status']) as PolicyStance,
    policyUrl: nullable(row['policy_url']),
    policyTextSnapshot: nullable(row['policy_text_snapshot']),
    policyTextHash: nullable(row['policy_text_hash']),
    effectiveAt: iso(row['effective_at']),
    lastReviewedAt: row['last_reviewed_at'] == null ? null : iso(row['last_reviewed_at']),
    reviewedBy: nullable(row['reviewed_by']),
    reviewNotes: nullable(row['review_notes']),
    productionApprovedBy: nullable(row['production_approved_by']),
    productionApprovedAt:
      row['production_approved_at'] == null ? null : iso(row['production_approved_at']),
    productionApprovalNote: nullable(row['production_approval_note']),
    createdAt: iso(row['created_at']),
  };
}

async function appendAudit(
  client: SqlClient,
  actor: string,
  action: string,
  entityId: Uuid,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`select audit_event_append($1,$2,'source_policy',$3,$4,'operator',null)`, [
    actor,
    action,
    entityId,
    JSON.stringify(payload),
  ]);
}
