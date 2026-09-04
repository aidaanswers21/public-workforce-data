import type {
  ComplaintChannel,
  ComplaintResolution,
  SuppressionEntryRecord,
  SuppressionScope,
  SuppressionSource,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
import { runAtomically, type SqlClient } from '../client.js';

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
  /** Stable delivery id supplied by the intake boundary for retry safety. */
  idempotencyKey: string;
  channel: ComplaintChannel;
  /** `email`, `phone`, `postal`, or whatever the complainant actually gave us. */
  contactType: string;
  contactValue: string;
  reason: string;
  notes?: string | null;
  receivedAt?: Timestamp;
  /**
   * The person the complaint is about, when the operator already knows.
   *
   * Supplying it skips resolution, which is how a postal complaint that a
   * person has matched by hand becomes a suppression.
   */
  personId?: Uuid | null;
  /** Whether to create the matching suppression entry. Defaults to true. */
  suppress?: boolean;
  createdBy: string;
}

export interface RecordComplaintResult {
  complaintId: Uuid;
  suppressionEntryId: Uuid | null;
  resolution: ComplaintResolution;
  /** Set when a person has to look at it. Never the reason it failed to parse. */
  reviewReason: string | null;
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
    await runAtomically(this.client, async (tx) => {
      await tx.query(`select set_config('app.actor_type', 'operator', true)`);
      await tx.query(`select set_config('app.actor_identifier', $1, true)`, [actor]);
      const updated = await tx.query<{ id: Uuid }>(
        `update suppression_entries
         set revoked_at = now(), revoked_reason = $2
         where id = $1 and revoked_at is null
         returning id`,
        [id, reason],
      );
      if (updated.rows[0] === undefined) {
        throw new Error(`suppression entry ${id} does not exist or is already revoked`);
      }
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

  /**
   * Record a complaint, and suppress whoever it is about when that is knowable.
   *
   * The complaint is written first and unconditionally. Someone asking not to
   * be contacted has done their part, and losing that because the platform
   * could not work out which row they meant would be the worst possible
   * outcome. An email complaint usually resolves to a person; a phone or postal
   * one usually does not, and that is a queue for a person rather than an
   * error.
   *
   * The one thing never done here is a person-scope suppression with no person.
   * The schema rejects it, and the reason the schema rejects it is that such a
   * row matches nobody while looking like protection.
   *
   * Intake and resolution are deliberately separate commits. The complaint is
   * durable before resolution starts, so a failed suppression cannot erase the
   * request that asked for it.
   */
  async recordComplaint(input: RecordComplaintInput): Promise<RecordComplaintResult> {
    const contactType = input.contactType.trim().toLowerCase();
    const contactValueOriginal = input.contactValue.trim();
    const contactValue = normalizeComplaintContact(contactType, contactValueOriginal);
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length === 0) throw new Error('complaint idempotency key is required');

    const inserted = await this.client.query<{ id: Uuid }>(
      `insert into complaints (
         idempotency_key, received_at, channel, contact_type, contact_value,
         contact_value_normalized, reason, notes, created_by, resolution
       ) values ($1,coalesce($2::timestamptz, now()),$3,$4,$5,$6,$7,$8,$9,'pending')
       on conflict (idempotency_key) do nothing
       returning id`,
      [
        idempotencyKey,
        input.receivedAt ?? null,
        input.channel,
        contactType,
        contactValueOriginal,
        contactValue,
        input.reason,
        input.notes ?? null,
        input.createdBy,
      ],
    );

    let complaintId = inserted.rows[0]?.id;
    if (complaintId === undefined) {
      const existing = await this.loadComplaintByIdempotencyKey(idempotencyKey);
      if (existing === null) throw new Error('complaints: retry lookup returned no row');
      complaintId = existing.complaintId;
      if (existing.reviewReason !== 'suppression_failed' && existing.resolution !== 'pending') {
        return existing;
      }
    }

    try {
      return await runAtomically(this.client, async (tx) => {
        const scoped = new ComplianceRepository(tx);
        const locked = await scoped.lockComplaint(complaintId);
        if (locked.reviewReason === 'suppression_failed') {
          await tx.query(
            `update complaints set resolution = 'pending', review_reason = null where id = $1`,
            [complaintId],
          );
        } else if (locked.resolution !== 'pending') {
          return locked;
        }

        await scoped.appendAudit({
          actorType: 'operator',
          actor: input.createdBy,
          action: 'complaint.received',
          entityType: 'complaint',
          entityId: complaintId,
          payload: { channel: input.channel, contactType },
        });

        if (input.suppress === false) {
          const reviewReason = 'operator_recorded_without_suppression';
          await tx.query(
            `update complaints set resolution = 'dismissed', review_reason = $2 where id = $1`,
            [complaintId, reviewReason],
          );
          return {
            complaintId,
            suppressionEntryId: null,
            resolution: 'dismissed' as const,
            reviewReason,
          };
        }

        let contactSuppressionId: Uuid | null = null;
        if (contactType === 'email' && contactValue.includes('@')) {
          contactSuppressionId = await scoped.addSuppression({
            scope: 'email',
            value: contactValue,
            reason: input.reason,
            source: 'complaint',
            createdBy: input.createdBy,
          });
        }

        const matches =
          input.personId == null
            ? await scoped.resolvePeople(contactType, contactValue)
            : [input.personId];

        if (matches.length === 1) {
          const personId = matches[0] as Uuid;
          const personSuppressionId = await scoped.addSuppression({
            scope: 'person',
            value: personId,
            personId,
            reason: input.reason,
            source: 'complaint',
            createdBy: input.createdBy,
          });
          await tx.query(
            `update complaints set person_id = $2, resolution = 'suppressed',
               review_reason = null, suppression_entry_id = $3 where id = $1`,
            [complaintId, personId, personSuppressionId],
          );
          return {
            complaintId,
            suppressionEntryId: personSuppressionId,
            resolution: 'suppressed' as const,
            reviewReason: null,
          };
        }

        const reviewReason =
          matches.length > 1
            ? 'multiple_matching_people'
            : contactType === 'email' || contactType === 'phone'
              ? 'no_matching_person'
              : 'unsupported_contact_type';
        await tx.query(
          `update complaints set resolution = 'needs_review', review_reason = $2,
             suppression_entry_id = $3 where id = $1`,
          [complaintId, reviewReason, contactSuppressionId],
        );
        await scoped.appendAudit({
          actorType: 'operator',
          actor: input.createdBy,
          action: 'complaint.needs_review',
          entityType: 'complaint',
          entityId: complaintId,
          payload: { contactType, reasonCode: reviewReason },
        });
        return {
          complaintId,
          suppressionEntryId: contactSuppressionId,
          resolution: 'needs_review' as const,
          reviewReason,
        };
      });
    } catch {
      const reviewReason = 'suppression_failed';
      const updated = await this.client.query<{ id: Uuid }>(
        `update complaints set resolution = 'needs_review', review_reason = $2,
           suppression_entry_id = null where id = $1 and resolution = 'pending'
         returning id`,
        [complaintId, reviewReason],
      );
      if (updated.rows[0] === undefined) {
        const resolved = await this.loadComplaintByIdempotencyKey(idempotencyKey);
        if (resolved !== null && resolved.resolution !== 'pending') return resolved;
      }
      return {
        complaintId,
        suppressionEntryId: null,
        resolution: 'needs_review',
        reviewReason,
      };
    }
  }

  /**
   * Find the person a complaint is about, or admit that we cannot.
   *
   * An email address is held on the person, so it resolves. A phone number is
   * held as a contact point, so it resolves when the source published it. A
   * postal address is held nowhere, so it does not, and returning null is the
   * honest answer rather than a guess.
   */
  async resolvePeople(contactType: string, contactValue: string): Promise<Uuid[]> {
    const value = normalizeComplaintContact(contactType, contactValue);
    if (value.length === 0) return [];

    if (contactType === 'email') {
      const result = await this.client.query<{ person_id: Uuid }>(
        `select distinct person_id from email_addresses
         where address_normalized = $1 and person_id is not null
         order by person_id limit 2`,
        [value],
      );
      return result.rows.map((row) => row.person_id);
    }

    if (contactType === 'phone') {
      const result = await this.client.query<{ person_id: Uuid }>(
        `select distinct person_id from contact_points
         where contact_point_type_code = 'work_phone'
           and value_normalized = $1 and person_id is not null
         order by person_id limit 2`,
        [value],
      );
      return result.rows.map((row) => row.person_id);
    }

    return [];
  }

  /** Complaints waiting for a person to match them to a record. */
  async complaintReviewQueue(
    limit = 50,
  ): Promise<
    { id: Uuid; channel: string; contactType: string; reason: string; reviewReason: string }[]
  > {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, channel, contact_type, reason, review_reason
       from complaints where resolution = 'needs_review'
       order by received_at limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row['id'] as Uuid,
      channel: row['channel'] as string,
      contactType: row['contact_type'] as string,
      reason: row['reason'] as string,
      reviewReason: (row['review_reason'] as string | null) ?? '',
    }));
  }

  /**
   * Append one audit event, chained to the previous one.
   *
   * The hash covers the previous hash, so removing or altering an event breaks
   * every event after it. Combined with the append-only trigger, that makes the
   * trail tamper-evident rather than merely tidy.
   */
  async appendAudit(input: {
    actorType?: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: Uuid | null;
    payload: Record<string, unknown>;
    occurredAt?: Timestamp;
  }): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `select audit_event_append($1,$2,$3,$4,$5,$6,$7) as id`,
      [
        input.actor,
        input.action,
        input.entityType,
        input.entityId,
        JSON.stringify(input.payload),
        input.actorType ?? 'application',
        input.occurredAt ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('audit_events: insert returned no id');
    return id;
  }

  /** Walk the chain and report the first event whose hash does not line up. */
  async verifyAuditChain(): Promise<{ valid: boolean; brokenAtId: Uuid | null }> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, sequence_number, prev_hash, hash,
              audit_event_hash(
                prev_hash, sequence_number, occurred_at, actor_type, actor, action,
                entity_type, entity_id, payload
              ) as recomputed_hash
       from audit_events order by sequence_number`,
    );
    let expectedPrev: string | null = null;
    let expectedSequence: bigint | null = null;
    for (const row of result.rows) {
      const sequence = BigInt(String(row['sequence_number']));
      if (expectedSequence !== null && sequence <= expectedSequence) {
        return { valid: false, brokenAtId: row['id'] as Uuid };
      }
      if (row['prev_hash'] !== expectedPrev || row['recomputed_hash'] !== row['hash']) {
        return { valid: false, brokenAtId: row['id'] as Uuid };
      }
      expectedSequence = sequence;
      expectedPrev = String(row['hash']);
    }
    return { valid: true, brokenAtId: null };
  }

  private async loadComplaintByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RecordComplaintResult | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, suppression_entry_id, resolution, review_reason
       from complaints where idempotency_key = $1`,
      [idempotencyKey],
    );
    return complaintResult(result.rows[0]);
  }

  private async lockComplaint(complaintId: Uuid): Promise<RecordComplaintResult> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, suppression_entry_id, resolution, review_reason
       from complaints where id = $1 for update`,
      [complaintId],
    );
    const complaint = complaintResult(result.rows[0]);
    if (complaint === null)
      throw new Error(`complaint ${complaintId} disappeared during resolution`);
    return complaint;
  }
}

function complaintResult(row: Record<string, unknown> | undefined): RecordComplaintResult | null {
  if (row === undefined) return null;
  return {
    complaintId: row['id'] as Uuid,
    suppressionEntryId: (row['suppression_entry_id'] as Uuid | null) ?? null,
    resolution: row['resolution'] as ComplaintResolution,
    reviewReason: (row['review_reason'] as string | null) ?? null,
  };
}

function normalizeComplaintContact(contactType: string, value: string): string {
  const trimmed = value.trim();
  if (contactType === 'email') return trimmed.toLowerCase();
  if (contactType === 'phone') {
    const digits = trimmed.replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  }
  if (contactType === 'postal') return trimmed.toLowerCase().replace(/\s+/g, ' ');
  return trimmed;
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
