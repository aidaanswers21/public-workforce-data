import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sharedTypes from '@pan/shared-types';
import { TestDatabase } from './testing.js';
import { ENUM_TYPE_TO_CONSTANT } from './schema.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await TestDatabase.create();
});

afterAll(async () => {
  await database.close();
});

describe('database enums match the shared vocabulary', () => {
  it.each(Object.entries(ENUM_TYPE_TO_CONSTANT))(
    'postgres type %s matches %s',
    async (typeName, constantName) => {
      const result = await database.query<{ label: string }>(
        `select e.enumlabel as label
         from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = $1
         order by e.enumsortorder`,
        [typeName],
      );
      const inDatabase = result.rows.map((row) => row.label);
      const inCode = (sharedTypes as unknown as Record<string, readonly string[]>)[constantName];

      expect(inCode, `${constantName} is not exported from @pan/shared-types`).toBeDefined();
      expect(inDatabase.length, `postgres type ${typeName} not found`).toBeGreaterThan(0);
      expect([...inDatabase].sort()).toEqual([...(inCode ?? [])].sort());
    },
  );
});

describe('structural guarantees', () => {
  it('email_addresses cannot hold an inferred candidate', async () => {
    const check = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'email_addresses_observed_only'`,
    );
    expect(check.rows[0]?.definition).toContain('published');
    expect(check.rows[0]?.definition).not.toContain('inferred_candidate');
  });

  it('records that must be traceable carry a provenance check', async () => {
    const result = await database.query<{ conname: string }>(
      `select conname from pg_constraint where conname like '%_has_provenance'`,
    );
    const names = result.rows.map((row) => row.conname);
    for (const table of [
      'districts',
      'schools',
      'people',
      'employment_assignments',
      'email_addresses',
    ]) {
      expect(names, `${table} is missing a provenance constraint`).toContain(
        `${table}_has_provenance`,
      );
    }
  });

  it('a completed export must record its suppression check', async () => {
    const result = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'exports_completed_requires_suppression_check'`,
    );
    expect(result.rows[0]?.definition).toContain('suppression_checked_at');
  });
});
