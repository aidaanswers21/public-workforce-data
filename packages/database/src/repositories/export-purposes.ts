import type { Timestamp } from '@public-workforce/shared-types';
import type { SqlClient } from '../client.js';

export interface ExportPurpose {
  code: string;
  description: string;
  owner: string;
  approvedBy: string;
  approvedAt: Timestamp;
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
    return {
      code: String(row['code']),
      description: String(row['description']),
      owner: String(row['owner']),
      approvedBy: String(row['approved_by']),
      approvedAt: new Date(String(row['approved_at'])).toISOString(),
    };
  }
}
