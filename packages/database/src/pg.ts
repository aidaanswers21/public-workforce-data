import pg from 'pg';
import type { SqlClient, Transactional } from './client.js';
import { withTransaction } from './client.js';

export interface PostgresOptions {
  connectionString: string;
  max?: number;
  /** Statement timeout in milliseconds. Keeps a runaway query from holding a worker. */
  statementTimeoutMs?: number;
}

/**
 * A `pg` pool behind the SqlClient interface.
 *
 * The connection string is read from the environment by the caller and never
 * stored in this repository. See `.env.example` for the variable names.
 */
export class PostgresClient implements Transactional {
  private readonly pool: pg.Pool;

  constructor(options: PostgresOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    });
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    const result = await this.pool.query(text, params === undefined ? undefined : [...params]);
    return { rows: result.rows as T[] };
  }

  async transaction<T>(run: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      const scoped: SqlClient = {
        query: async <R>(text: string, params?: readonly unknown[]) => {
          const result = await connection.query(
            text,
            params === undefined ? undefined : [...params],
          );
          return { rows: result.rows as R[] };
        },
      };
      return await withTransaction(scoped, run);
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
