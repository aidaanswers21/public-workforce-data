import { PGlite } from '@electric-sql/pglite';
import { Taxonomy, type SectorPack } from '@pan/taxonomy';
import type { SqlClient } from './client.js';
import { loadMigrations, migrate } from './migrations.js';
import { seedReferenceData } from './reference-seed.js';

/**
 * An in-process PostgreSQL 16 for tests.
 *
 * Real Postgres, not a mock: constraints, triggers, `on conflict` semantics and
 * `nulls not distinct` all behave exactly as they will in Supabase, which is
 * the whole point of testing the data layer at all.
 */
export class TestDatabase implements SqlClient {
  private constructor(private readonly db: PGlite) {}

  static async create(
    options: { migrate?: boolean; seed?: boolean; sectors?: readonly SectorPack[] } = {},
  ): Promise<TestDatabase> {
    const database = new TestDatabase(new PGlite());
    if (options.migrate !== false) await migrate(database, loadMigrations());
    // Reference data is seeded from the taxonomy, not from a migration, which
    // is what lets a sector add an organization type without a schema change.
    if (options.migrate !== false && options.seed !== false) {
      await seedReferenceData(database, new Taxonomy(options.sectors ?? []));
    }
    return database;
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

  async close(): Promise<void> {
    await this.db.close();
  }

  /** Convenience for assertions: the single scalar a count query returns. */
  async count(table: string, where = '', params: readonly unknown[] = []): Promise<number> {
    const clause = where.length > 0 ? ` where ${where}` : '';
    const result = await this.query<{ n: string }>(
      `select count(*)::int as n from ${table}${clause}`,
      params,
    );
    return Number(result.rows[0]?.n ?? 0);
  }
}
