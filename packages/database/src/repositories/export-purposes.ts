import type { Timestamp } from '@public-workforce/shared-types';
import type { SqlClient } from '../client.js';

export interface ExportPurpose {
  code: string;
  description: string;
  owner: string;
  approvedBy: string;
  approvedAt: Timestamp;
}

export interface ApproveExportPurposeInput {
  code: string;
  description: string;
  owner: string;
  approvedBy: string;
  approvedAt?: Timestamp;
}

/** Controlled, human-approved reasons for reading or exporting person records. */
export class ExportPurposeRepository {
  constructor(private readonly client: SqlClient) {}

  async findActive(code: string): Promise<ExportPurpose | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `select code, description, owner, approved_by, approved_at
       from export_purposes
       where code = $1 and active and retired_at is null`,
      [code],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return toExportPurpose(row);
  }

  async listActive(): Promise<ExportPurpose[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select code, description, owner, approved_by, approved_at
       from export_purposes
       where active and retired_at is null
       order by code`,
    );
    return result.rows.map(toExportPurpose);
  }

  async approve(input: ApproveExportPurposeInput): Promise<ExportPurpose> {
    if (input.description.trim().length < 8) {
      throw new Error('export purpose description must contain at least 8 characters');
    }
    const approvedAt = input.approvedAt ?? new Date().toISOString();
    const result = await this.client.query<Record<string, unknown>>(
      `insert into export_purposes (
         code, description, owner, approved_by, approved_at, active
       ) values ($1,$2,$3,$4,$5,true)
       returning code, description, owner, approved_by, approved_at`,
      [input.code.trim(), input.description.trim(), input.owner, input.approvedBy, approvedAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('export purpose approval returned no row');
    return toExportPurpose(row);
  }
}

function toExportPurpose(row: Record<string, unknown>): ExportPurpose {
  return {
    code: String(row['code']),
    description: String(row['description']),
    owner: String(row['owner']),
    approvedBy: String(row['approved_by']),
    approvedAt: new Date(String(row['approved_at'])).toISOString(),
  };
}
