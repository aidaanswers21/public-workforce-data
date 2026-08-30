import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from './testing.js';
import { TABLE_NAMES } from './schema.js';
import {
  appliedMigrations,
  checkMigrations,
  loadMigrations,
  migrate,
  rollback,
} from './migrations.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

describe('migration files', () => {
  const migrations = loadMigrations();

  it('finds every migration', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('has no static issues: unique versions, non-empty, and a down script each', () => {
    expect(checkMigrations(migrations)).toEqual([]);
  });

  it('numbers versions without gaps', () => {
    const versions = migrations.map((m) => Number(m.version));
    expect(versions).toEqual(versions.map((_, index) => index + 1));
  });
});

describe('migrate', () => {
  it('creates every table the schema declares', async () => {
    database = await TestDatabase.create({ seed: false });
    const result = await database.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    const present = new Set(result.rows.map((row) => row.tablename));
    for (const table of TABLE_NAMES) {
      expect(present.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('records what it applied', async () => {
    database = await TestDatabase.create({ seed: false });
    const applied = await appliedMigrations(database);
    expect(applied.map((row) => row.version)).toEqual(loadMigrations().map((m) => m.version));
  });

  it('is idempotent: a second run applies nothing', async () => {
    database = await TestDatabase.create({ seed: false });
    const second = await migrate(database, loadMigrations());
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    database = await TestDatabase.create({ seed: false });
    const tampered = loadMigrations().map((migration, index) =>
      index === 0 ? { ...migration, checksum: 'deadbeef' } : migration,
    );
    await expect(migrate(database, tampered)).rejects.toThrow(/modified after it was applied/);
  });
});

describe('rollback', () => {
  it('reverses every migration and leaves no tables behind', async () => {
    database = await TestDatabase.create({ seed: false });
    const migrations = loadMigrations();
    const reverted = await rollback(database, migrations);
    expect(reverted).toHaveLength(migrations.length);

    const result = await database.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    const remaining = result.rows
      .map((row) => row.tablename)
      .filter((name) => name !== 'schema_migrations');
    expect(remaining).toEqual([]);
  });

  it('drops the enum types too, so a re-migrate succeeds', async () => {
    database = await TestDatabase.create({ seed: false });
    const migrations = loadMigrations();
    await rollback(database, migrations);
    const again = await migrate(database, migrations);
    expect(again.applied).toHaveLength(migrations.length);
  });

  it('rolls back only down to the requested version', async () => {
    database = await TestDatabase.create({ seed: false });
    const migrations = loadMigrations();
    const reverted = await rollback(database, migrations, '0007');
    expect(reverted).toEqual(['0009', '0008', '0007']);
    expect(await database.count('people')).toBe(0);
  });
});
