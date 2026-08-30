import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sharedTypes from '@pan/shared-types';
import { Taxonomy } from '@pan/taxonomy';
import { educationSectorPack } from '@pan/sector-education';
import { TestDatabase } from './testing.js';
import { ENUM_TYPE_TO_CONSTANT, REFERENCE_TABLE_NAMES } from './schema.js';
import { seedReferenceData } from './reference-seed.js';

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

describe('extensible vocabularies are reference data, not enums', () => {
  it.each([...REFERENCE_TABLE_NAMES])('%s is a table', async (table) => {
    const result = await database.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name = $1`,
      [table],
    );
    expect(result.rows[0]?.n).toBe(1);
  });

  it.each(['organization_type', 'sector', 'role_category', 'source_type', 'identifier_system'])(
    '%s is not a postgres enum, so extending it needs no migration',
    async (typeName) => {
      const result = await database.query<{ n: number }>(
        `select count(*)::int as n from pg_type where typname = $1 and typtype = 'e'`,
        [typeName],
      );
      expect(result.rows[0]?.n).toBe(0);
    },
  );

  it('seeds every level of government the platform supports', async () => {
    const result = await database.query<{ code: string }>('select code from government_levels');
    const codes = result.rows.map((row) => row.code);
    for (const level of [
      'federal',
      'state',
      'county',
      'municipal',
      'township',
      'special_district',
      'tribal',
      'education',
      'other_public_authority',
    ]) {
      expect(codes).toContain(level);
    }
  });

  it('a sector adds an organization type by re-seeding, with no schema change', async () => {
    const before = await database.query<{ n: number }>(
      `select count(*)::int as n from organization_types where code = 'school_district'`,
    );
    expect(before.rows[0]?.n).toBe(0);

    await seedReferenceData(database, new Taxonomy([educationSectorPack]));

    const after = await database.query<{ n: number; sector_code: string }>(
      `select count(*)::int as n, max(sector_code) as sector_code
       from organization_types where code = 'school_district'`,
    );
    expect(after.rows[0]?.n).toBe(1);
    expect(after.rows[0]?.sector_code).toBe('education');
  });

  it('re-seeding is idempotent', async () => {
    const taxonomy = new Taxonomy([educationSectorPack]);
    await seedReferenceData(database, taxonomy);
    const first = await database.count('organization_types');
    await seedReferenceData(database, taxonomy);
    expect(await database.count('organization_types')).toBe(first);
  });
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
      'organizations',
      'organization_relationships',
      'organization_locations',
      'external_identifiers',
      'people',
      'employment_assignments',
      'email_addresses',
      'contact_points',
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

  it('every suppression scope must name what it covers', async () => {
    const result = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'suppression_scope_target'`,
    );
    const definition = result.rows[0]?.definition ?? '';
    for (const scope of [
      'organization_subtree',
      'jurisdiction',
      'geographic_area',
      'export_purpose',
    ]) {
      expect(definition).toContain(scope);
    }
  });

  it('a prohibited source policy cannot carry a production approval', async () => {
    const result = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'source_policies_prohibited_not_approved'`,
    );
    expect(result.rows[0]?.definition).toContain('prohibited');
  });

  it('organizations have no parent column, so hierarchy is effective-dated', async () => {
    const result = await database.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'organizations' and column_name in ('parent_id', 'parent_organization_id')`,
    );
    expect(result.rows).toEqual([]);
  });

  it('the education extension is keyed to organizations, not embedded in them', async () => {
    const onOrganizations = await database.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'organizations'
         and column_name in ('low_grade', 'high_grade', 'enrollment', 'is_charter', 'nces_id')`,
    );
    expect(onOrganizations.rows).toEqual([]);

    const extension = await database.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'education_organization_attributes' and column_name = 'organization_id'`,
    );
    expect(extension.rows).toHaveLength(1);
  });
});
