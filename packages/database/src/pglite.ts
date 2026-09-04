import { PGlite } from '@electric-sql/pglite';
import type { SqlClient, Transactional } from './client.js';

/**
 * A persistent, embedded PostgreSQL database for local operator workflows.
 *
 * The database files stay in the workspace. This is deliberately separate
 * from the production Postgres client and is never selected implicitly by a
 * worker or API process.
 */
export class PGliteClient implements Transactional {
  private constructor(private readonly db: PGlite) {}

  static async open(dataDirectory: string): Promise<PGliteClient> {
    return new PGliteClient(await PGlite.create(dataDirectory));
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    const result = await this.db.query<T>(text, params === undefined ? undefined : [...params]);
    return { rows: result.rows };
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }

  async transaction<T>(run: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction) => {
      const scoped: SqlClient = {
        query: async <R>(text: string, params?: readonly unknown[]) => {
          const result = await transaction.query<R>(
            text,
            params === undefined ? undefined : [...params],
          );
          return { rows: result.rows };
        },
        exec: async (sql: string) => transaction.exec(sql),
      };
      return run(scoped);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
