import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execScript, type SqlClient } from './client.js';

export interface Migration {
  version: string;
  name: string;
  upSql: string;
  /** Null when no down script exists. Reported by `checkMigrations`. */
  downSql: string | null;
  checksum: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Repository-root-relative path to the SQL, resolved from this package. */
export const DEFAULT_MIGRATIONS_DIR = resolve(here, '..', '..', '..', 'supabase', 'migrations');

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(directory: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const downDirectory = join(directory, 'down');
  const migrations: Migration[] = [];

  for (const file of readdirSync(directory).sort()) {
    const match = FILE_PATTERN.exec(file);
    if (match === null) continue;
    const [, version, name] = match as unknown as [string, string, string];
    const upSql = readFileSync(join(directory, file), 'utf8');
    const downPath = join(downDirectory, file);
    migrations.push({
      version,
      name,
      upSql,
      downSql: existsSync(downPath) ? readFileSync(downPath, 'utf8') : null,
      checksum: createHash('sha256').update(upSql).digest('hex'),
    });
  }

  return migrations;
}

const MIGRATIONS_TABLE = `
create table if not exists schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);
`;

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export async function appliedMigrations(client: SqlClient): Promise<AppliedMigration[]> {
  await execScript(client, MIGRATIONS_TABLE);
  const result = await client.query<AppliedMigration>(
    'select version, name, checksum from schema_migrations order by version',
  );
  return result.rows;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every migration not yet recorded, in version order.
 *
 * A checksum mismatch on an already-applied migration is a hard error: editing
 * a shipped migration silently diverges environments, and the fix is a new
 * migration, not a rewritten one.
 */
export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<MigrateResult> {
  const already = await appliedMigrations(client);
  const byVersion = new Map(already.map((row) => [row.version, row]));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const existing = byVersion.get(migration.version);
    if (existing !== undefined) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `migration ${migration.version}_${migration.name} was modified after it was applied ` +
            `(recorded ${existing.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}). ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      skipped.push(migration.version);
      continue;
    }
    await execScript(client, migration.upSql);
    await client.query(
      'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    applied.push(migration.version);
  }

  return { applied, skipped };
}

/** Roll back applied migrations, newest first, down to and including `toVersion`. */
export async function rollback(
  client: SqlClient,
  migrations: readonly Migration[] = loadMigrations(),
  toVersion?: string,
): Promise<string[]> {
  const already = await appliedMigrations(client);
  const appliedVersions = new Set(already.map((row) => row.version));
  const reverted: string[] = [];

  for (const migration of [...migrations].reverse()) {
    if (!appliedVersions.has(migration.version)) continue;
    if (toVersion !== undefined && migration.version < toVersion) break;
    if (migration.downSql === null) {
      throw new Error(`migration ${migration.version}_${migration.name} has no down script`);
    }
    await execScript(client, migration.downSql);
    await client.query('delete from schema_migrations where version = $1', [migration.version]);
    reverted.push(migration.version);
  }

  return reverted;
}

export interface MigrationIssue {
  version: string;
  problem: string;
}

/** Static checks that run without a database. */
export function checkMigrations(migrations: readonly Migration[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const seen = new Set<string>();

  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      issues.push({ version: migration.version, problem: 'duplicate version number' });
    }
    seen.add(migration.version);
    if (migration.downSql === null) {
      issues.push({ version: migration.version, problem: 'no down script' });
    }
    if (migration.upSql.trim().length === 0) {
      issues.push({ version: migration.version, problem: 'empty up script' });
    }
  }

  return issues;
}
