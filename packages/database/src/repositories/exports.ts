import {
  SuppressionIndex,
  exportPeopleCsv,
  nowTimestamp,
  type Clock,
  type ExportResult,
} from '@pan/core';
import type { Timestamp, Uuid } from '@pan/shared-types';
import type { SqlClient } from '../client.js';
import { ComplianceRepository } from './compliance.js';
import { QueryRepository, type ExportFilters } from './queries.js';

export interface BuildExportInput {
  name: string;
  requestedBy: string;
  filters: ExportFilters;
}

export interface BuiltExport extends ExportResult {
  exportId: Uuid;
}

/**
 * Builds an export and records what it contained.
 *
 * Suppression is applied twice on purpose. The SQL query filters it, and then
 * the index is re-consulted immediately before the CSV is rendered, so an
 * opt-out recorded while the query was running still keeps the record out of
 * the file. There is no code path here that writes bytes without both.
 */
export class ExportRepository {
  private readonly queries: QueryRepository;
  private readonly compliance: ComplianceRepository;

  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = () => new Date(),
  ) {
    this.queries = new QueryRepository(client);
    this.compliance = new ComplianceRepository(client);
  }

  async buildPeopleExport(input: BuildExportInput): Promise<BuiltExport> {
    const requestedAt: Timestamp = nowTimestamp(this.clock);
    const created = await this.client.query<{ id: Uuid }>(
      `insert into exports (name, requested_by, filters, status) values ($1,$2,$3,'building') returning id`,
      [input.name, input.requestedBy, JSON.stringify(input.filters)],
    );
    const exportId = created.rows[0]?.id;
    if (exportId === undefined) throw new Error('exports: insert returned no id');

    try {
      const rows = await this.queries.queryExportableRows(requestedAt, input.filters);

      // Re-read suppression after the rows are in hand, then check again.
      const suppression = SuppressionIndex.fromEntries(
        await this.compliance.loadActiveSuppressions(),
      );
      const checkedAt: Timestamp = nowTimestamp(this.clock);
      const result = exportPeopleCsv({ rows, suppression, at: checkedAt });

      await this.client.query(
        `update exports set status = 'completed', row_count = $2, suppressed_count = $3,
                checksum = $4, suppression_checked_at = $5, completed_at = $5
         where id = $1`,
        [exportId, result.rowCount, result.suppressedCount, result.checksum, checkedAt],
      );
      await this.compliance.appendAudit({
        actor: input.requestedBy,
        action: 'export.completed',
        entityType: 'export',
        entityId: exportId,
        payload: {
          name: input.name,
          rowCount: result.rowCount,
          suppressedCount: result.suppressedCount,
          checksum: result.checksum,
          filters: input.filters,
        },
      });

      return { ...result, exportId };
    } catch (error) {
      await this.client.query(`update exports set status = 'failed' where id = $1`, [exportId]);
      await this.compliance.appendAudit({
        actor: input.requestedBy,
        action: 'export.failed',
        entityType: 'export',
        entityId: exportId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }
}
