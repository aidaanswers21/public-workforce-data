import {
  NoopValidationProvider,
  qualifiesForPromotion,
  type EmailValidationProvider,
  type ValidationRequestItem,
} from '@public-workforce/core';
import type { Uuid } from '@public-workforce/shared-types';
import type { Logger } from '@public-workforce/observability';
import type { SqlClient } from '@public-workforce/database';

export interface ValidationRunSummary {
  requested: number;
  valid: number;
  invalid: number;
  other: number;
  promoted: number;
  provider: string;
}

/**
 * Sends pending candidates to whichever provider is configured.
 *
 * The default provider is a no-op that marks everything unvalidated, so an
 * unconfigured deployment produces honest data and cannot spend money. A
 * candidate is promoted only when a provider actually returns "valid";
 * "accept_all" does not qualify, because a catch-all domain says nothing about
 * whether the mailbox exists.
 */
export class ValidationRunner {
  constructor(
    private readonly deps: {
      client: SqlClient;
      logger: Logger;
      provider?: EmailValidationProvider;
    },
  ) {}

  async validatePendingCandidates(limit = 500): Promise<ValidationRunSummary> {
    const provider = this.deps.provider ?? new NoopValidationProvider();
    const pending = await this.deps.client.query<{ id: Uuid; address: string }>(
      `select id, address from email_candidates
       where state = 'pending' and validation_status = 'unvalidated'
       order by confidence desc limit $1`,
      [limit],
    );

    const summary: ValidationRunSummary = {
      requested: pending.rows.length,
      valid: 0,
      invalid: 0,
      other: 0,
      promoted: 0,
      provider: provider.info.key,
    };
    if (pending.rows.length === 0) return summary;

    const items: ValidationRequestItem[] = pending.rows.map((row) => ({
      referenceId: row.id,
      address: row.address,
    }));

    for (const batch of chunk(items, provider.info.maxBatchSize)) {
      const results = await provider.validateBatch(batch);
      for (const result of results) {
        const inserted = await this.deps.client.query<{ id: Uuid }>(
          `insert into email_validation_results (
             email_candidate_id, provider, provider_request_id, status, sub_status, score, raw, validated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [
            result.referenceId,
            provider.info.key,
            result.providerRequestId,
            result.status,
            result.subStatus,
            result.score,
            JSON.stringify(result.raw),
            result.validatedAt,
          ],
        );

        const promote = qualifiesForPromotion(result.status);
        await this.deps.client.query(
          `update email_candidates set
             validation_status = $2,
             latest_validation_result_id = $3,
             state = case when $4::boolean then 'promoted'::email_candidate_state
                          when $2 = 'invalid' then 'rejected'::email_candidate_state
                          else state end,
             promoted_at = case when $4::boolean then now() else promoted_at end,
             updated_at = now()
           where id = $1`,
          [result.referenceId, result.status, inserted.rows[0]?.id ?? null, promote],
        );

        if (result.status === 'valid') summary.valid += 1;
        else if (result.status === 'invalid') summary.invalid += 1;
        else summary.other += 1;
        if (promote) summary.promoted += 1;
      }
    }

    this.deps.logger.info({ ...summary }, 'validation run complete');
    return summary;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
