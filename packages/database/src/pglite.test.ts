import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from './migrations.js';
import { PGliteClient } from './pglite.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PGliteClient', () => {
  it('applies multi-statement migrations and retains data after reopening', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'public-workforce-pglite-'));
    temporaryDirectories.push(parent);
    const dataDirectory = join(parent, 'database');

    const first = await PGliteClient.open(dataDirectory);
    const migrationResult = await migrate(first, loadMigrations());
    expect(migrationResult.applied.length).toBeGreaterThan(0);
    await first.query('create table persistence_probe (value text not null)');
    await first.query('insert into persistence_probe (value) values ($1)', ['retained']);
    await first.close();

    const reopened = await PGliteClient.open(dataDirectory);
    const result = await reopened.query<{ value: string }>('select value from persistence_probe');
    expect(result.rows).toEqual([{ value: 'retained' }]);
    await reopened.close();
  });
});
