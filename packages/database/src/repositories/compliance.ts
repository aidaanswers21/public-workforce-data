import type {
  ComplaintChannel,
  SuppressionEntryRecord,
  SuppressionScope,
  SuppressionSource,
  Timestamp,
  Uuid,
} from '@pan/shared-types';
import { hashObject } from '@pan/core';
import type { SqlClient } from '../client.js';

export interface AddSuppressionInput {
  scope: SuppressionScope;
  /** Normalized match value: an address, a domain, an entity id or a code. */
  value: string;
  personId?: Uuid | null;
  /** For `organization` and `organization_subtree` scopes. */
  organizationId?: Uuid | null;
  jurisdictionId?: Uuid | null;
  geographicAreaId?: Uuid | null;
  sourceDocumentId?: Uuid | null;
  governmentLevelCode?: string | null;
  /** For `export_purpose` scope: block one declared use, not the record itself. */
  exportPurpose?: string | null;
  reason: string;
  source: SuppressionSource;
  effectiveAt?: Timestamp;
  expiresAt?: Timestamp | null;
  createdBy: string;
}

export interface RecordComplaintInput {
  channel: ComplaintChannel;
  contactType: string;
  contactValue: string;
  reason: string;
  notes?: string | null;
  receivedAt?: Timestamp;
  /** Whether to create the matching suppression entry in the same transaction. */
  suppress?: boolean;
  createdBy: string;
}

/**
 * Suppression, complaints and the audit trail.
 *
 * Suppression lives here rather than in a service layer so that no export path
 * can reach the data without also being able to reach the opt-outs. The tables
 * enforce immutability with triggers, so this class never tries to update or
 * delete a row.
 */
export class ComplianceRepository {
  constructor(private readonly client: SqlClient) {}

  async addSuppression(input: AddSuppressionInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into suppression_entries (
         scope, value, person_id, organization_id, jurisdiction_id, geographic_area_id,
         source_document_id, government_level_code, export_purpose, reason, source,
         effective_at, expires_at, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz, now()),$13,$14)
       returning id`,
      [
        input.scope,
        input.value.trim().toLowerCase(),
        input.personId ?? null,
        input.organizationId ?? null,
        input.jurisdictionId ?? null,
        input.geographicAreaId ?? null,
        input.sourceDocumentId ?? null,
        input.governmentLevelCode ?? null,
        input.exportPurpose ?? null,
        input.reason,
        input.source,
        input.effectiveAt ?? null,
        input.expiresAt ?? null,
        input.createdBy,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('suppression_entries: insert returned no id');
    await this.appendAudit({
      actor: input.createdBy,
      action: 'suppression.added',
      entityType: 'suppression_entry',
      entityId: id,
      payload: { scope: input.scope, reason: input.reason, source: input.source },
    });
    return id;
  }

  /** Revocation is the only permitted mutation, and it is itself audited. */
  async revokeSuppression(id: Uuid, reason: string, actor: string): Promise<void> {
    await this.client.query(
      `update suppression_entries set revoked_at = now(), revoked_reason = $2 where id = $1`,
      [id, reason],
    );
    await this.appendAudit({
      actor,
      action: 'suppression.revoked',
      entityType: 'suppression_entry',
      entityId: id,
      payload: { reason },
    });
  }

  /** Every entry that is currently in force, for building a SuppressionIndex. */
  async loadActiveSuppressions(): Promise<SuppressionEntryRecord[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, scope, value, person_id, organization_id, jurisdiction_id, geographic_area_id,
              source_document_id, government_level_code, export_purpose, reason, source,
              effective_at, expires_at, revoked_at, revoked_reason, created_by, created_at
       from suppression_entries
       where revoked_at is null
       order by created_at`,
    );
    return result.rows.map(toSuppressionEntry);
  }

  async recordComplaint(
    input: RecordComplaintInput,
  ): Promise<{ complaintId: Uuid; suppressionEntryId: Uuid | null }> {
    let suppressionEntryId: Uuid | null = null;
    if (input.suppress !== false) {
      suppressionEntryId = await this.addSuppression({
        scope: input.contactType === 'email' ? 'email' : 'person',
        value: input.contactValue,
        reason: input.reason,
        source: 'complaint',
        createdBy: input.createdBy,
      });
    }

    const result = await this.client.query<{ id: Uuid }>(
      `insert into complaints (received_at, channel, contact_type, contact_value, reason, notes, suppression_entry_id)
       values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7) returning id`,
      [
        input.receivedAt ?? null,
        input.channel,
        input.contactType,
        input.contactValue,
        input.reason,
        input.notes ?? null,
        suppressionEntryId,
      ],
    );
    const complaintId = result.rows[0]?.id;
    if (complaintId === undefined) throw new Error('complaints: insert returned no id');
    return { complaintId, suppressionEntryId };
  }

  /**
   * Append one audit event, chained to the previous one.
   *
   * The hash covers the previous hash, so removing or altering an event breaks
   * every event after it. Combined with the append-only trigger, that makes the
   * trail tamper-evident rather than merely tidy.
   */
  async appendAudit(input: {
    actor: string;
    action: string;
    entityType: string;
    entityId: Uuid | null;
    payload: Record<string, unknown>;
  }): Promise<Uuid> {
    const previous = await this.client.query<{ hash: string }>(
      `select hash from audit_events order by occurred_at desc, id desc limit 1`,
    );
    const prevHash = previous.rows[0]?.hash ?? null;
    const hash = hashObject({
      prevHash,
      actor: input.actor,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
    });

    const result = await this.client.query<{ id: Uuid }>(
      `insert into audit_events (actor, action, entity_type, entity_id, payload, prev_hash, hash)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
        input.actor,
        input.action,
        input.entityType,
        input.entityId,
        JSON.stringify(input.payload),
        prevHash,
        hash,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('audit_events: insert returned no id');
    return id;
  }

  /** Walk the chain and report the first event whose hash does not line up. */
  async verifyAuditChain(): Promise<{ valid: boolean; brokenAtId: Uuid | null }> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, actor, action, entity_type, entity_id, payload, prev_hash, hash
       from audit_events order by occurred_at, id`,
    );
    let expectedPrev: string | null = null;
    for (const row of result.rows) {
      const payload =
        typeof row['payload'] === 'string'
          ? (JSON.parse(row['payload']) as Record<string, unknown>)
          : ((row['payload'] ?? {}) as Record<string, unknown>);
      const recomputed = hashObject({
        prevHash: expectedPrev,
        actor: row['actor'],
        action: row['action'],
        entityType: row['entity_type'],
        entityId: row['entity_id'] ?? null,
        payload,
      });
      if (recomputed !== row['hash']) return { valid: false, brokenAtId: row['id'] as Uuid };
      expectedPrev = row['hash'];
    }
    return { valid: true, brokenAtId: null };
  }
}

function toSuppressionEntry(row: Record<string, unknown>): SuppressionEntryRecord {
  return {
    id: row['id'] as Uuid,
    scope: row['scope'] as SuppressionScope,
    value: row['value'] as string,
    personId: (row['person_id'] as Uuid | null) ?? null,
    organizationId: (row['organization_id'] as Uuid | null) ?? null,
    jurisdictionId: (row['jurisdiction_id'] as Uuid | null) ?? null,
    geographicAreaId: (row['geographic_area_id'] as Uuid | null) ?? null,
    sourceDocumentId: (row['source_document_id'] as Uuid | null) ?? null,
    governmentLevelCode: (row['government_level_code'] as string | null) ?? null,
    exportPurpose: (row['export_purpose'] as string | null) ?? null,
    reason: row['reason'] as string,
    source: row['source'] as SuppressionSource,
    effectiveAt: toIso(row['effective_at']),
    expiresAt:
      row['expires_at'] === null || row['expires_at'] === undefined
        ? null
        : toIso(row['expires_at']),
    revokedAt:
      row['revoked_at'] === null || row['revoked_at'] === undefined
        ? null
        : toIso(row['revoked_at']),
    revokedReason: (row['revoked_reason'] as string | null) ?? null,
    createdBy: row['created_by'] as string,
    createdAt: toIso(row['created_at']),
  };
}

function toIso(value: unknown): Timestamp {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
