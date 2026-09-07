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

  it('upgrades the prior feature-branch schema without losing audit or complaint rows', async () => {
    database = await TestDatabase.create({ migrate: false, seed: false });
    const migrations = loadMigrations();
    await migrate(
      database,
      migrations.filter((migration) => migration.version < '0011'),
    );
    await database.query(
      `select audit_event_append(
         'upgrade-test', 'test.before_upgrade', 'test_subject', null, '{"before":true}'::jsonb
       )`,
    );
    await database.query(
      `insert into complaints (
         channel, contact_type, contact_value, reason, resolution
       ) values ('email','email','Original.Case@Example.gov','upgrade test','pending')`,
    );

    const upgraded = await migrate(database, migrations);
    expect(upgraded.applied).toEqual(['0011', '0012', '0013', '0014', '0015', '0016']);
    const audit = await database.query<{ sequence_number: string; valid: boolean }>(
      `select sequence_number,
              hash = audit_event_hash(
                prev_hash, sequence_number, occurred_at, actor_type, actor, action,
                entity_type, entity_id, payload
              ) as valid
       from audit_events`,
    );
    expect(Number(audit.rows[0]?.sequence_number)).toBe(1);
    expect(audit.rows[0]?.valid).toBe(true);
    const complaint = await database.query<{
      contact_value: string;
      contact_value_normalized: string;
      idempotency_key: string;
    }>(`select contact_value, contact_value_normalized, idempotency_key from complaints`);
    expect(complaint.rows[0]?.contact_value).toBe('Original.Case@Example.gov');
    expect(complaint.rows[0]?.contact_value_normalized).toBe('original.case@example.gov');
    expect(complaint.rows[0]?.idempotency_key).toMatch(/^legacy:/);
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
    expect(reverted).toEqual([
      '0016',
      '0015',
      '0014',
      '0013',
      '0012',
      '0011',
      '0010',
      '0009',
      '0008',
      '0007',
    ]);
    expect(await database.count('people')).toBe(0);
  });

  it('rolls 0011 down and up with a reviewed address suppression intact', async () => {
    database = await TestDatabase.create({ seed: false });
    const suppression = await database.query<{ id: string }>(
      `insert into suppression_entries (scope, value, reason, source, created_by)
       values ('email','shared@example.gov','shared address','complaint','ops')
       returning id`,
    );
    const suppressionId = suppression.rows[0]?.id;
    expect(suppressionId).toBeDefined();
    await database.query(
      `insert into complaints (
         idempotency_key, channel, contact_type, contact_value, contact_value_normalized,
         reason, created_by, resolution, review_reason, suppression_entry_id
       ) values (
         'rollback-reviewed-email','email','email','shared@example.gov','shared@example.gov',
         'shared address','ops','needs_review','multiple_matching_people',$1
       )`,
      [suppressionId],
    );

    const migrations = loadMigrations();
    expect(await rollback(database, migrations, '0011')).toEqual([
      '0016',
      '0015',
      '0014',
      '0013',
      '0012',
      '0011',
    ]);
    const rolledBack = await database.query<{
      resolution: string;
      suppression_entry_id: string | null;
    }>('select resolution, suppression_entry_id from complaints');
    expect(rolledBack.rows[0]).toEqual({
      resolution: 'needs_review',
      suppression_entry_id: null,
    });
    expect(await database.count('suppression_entries')).toBe(1);

    expect((await migrate(database, migrations)).applied).toEqual([
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
    ]);
    expect(await database.count('complaints')).toBe(1);
    expect(await database.count('suppression_entries')).toBe(1);
  });
});
