import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sharedTypes from '@public-workforce/shared-types';
import { Taxonomy } from '@public-workforce/taxonomy';
import { educationSectorPack } from '@public-workforce/sector-education';
import { TestDatabase } from './testing.js';
import { ENUM_TYPE_TO_CONSTANT, REFERENCE_TABLE_NAMES, TABLE_NAMES } from './schema.js';
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

      expect(
        inCode,
        `${constantName} is not exported from @public-workforce/shared-types`,
      ).toBeDefined();
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
      'other_public_authority',
    ]) {
      expect(codes).toContain(level);
    }
    // Education is a sector, not a level. See docs/DATA_MODEL.md.
    expect(codes).not.toContain('education');
  });

  it('a sector adds an organization type by re-seeding, with no schema change', async () => {
    const before = await database.query<{ n: number }>(
      `select count(*)::int as n from organization_types where code = 'school_district'`,
    );
    expect(before.rows[0]?.n).toBe(0);

    await seedReferenceData(database, new Taxonomy([educationSectorPack]));

    const after = await database.query<{
      n: number;
      default_sector_code: string;
      default_government_level_code: string | null;
    }>(
      `select count(*)::int as n,
              max(default_sector_code) as default_sector_code,
              max(default_government_level_code) as default_government_level_code
       from organization_types where code = 'school_district'`,
    );
    expect(after.rows[0]?.n).toBe(1);
    expect(after.rows[0]?.default_sector_code).toBe('education');
    // No default level, because a district is an independent special district
    // in some states and part of a city or county in others. The organization
    // records what its own source supports.
    expect(after.rows[0]?.default_government_level_code).toBeNull();
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

  it('every provenance-bearing table requires a real source document', async () => {
    // Not a nullable column with a CHECK that any UUID would satisfy: a NOT
    // NULL foreign key, so the row it names has to exist.
    const tables = [
      'organizations',
      'organization_relationships',
      'organizational_units',
      'organization_locations',
      'external_identifiers',
      'people',
      'employment_assignments',
      'contact_points',
      'email_addresses',
      'education_organization_attributes',
    ];
    for (const table of tables) {
      const column = await database.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_name = $1 and column_name = 'source_document_id'`,
        [table],
      );
      expect(column.rows[0]?.is_nullable, `${table}.source_document_id`).toBe('NO');

      const constraint = await database.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
         where conname = $1`,
        [`${table}_has_provenance`],
      );
      expect(constraint.rows[0]?.definition, `${table}_has_provenance`).toContain(
        'source_document_id',
      );
    }
  });

  it('carries no inference_evidence_id, because no inference-evidence model exists', async () => {
    const result = await database.query<{ table_name: string }>(
      `select table_name from information_schema.columns
       where column_name = 'inference_evidence_id'`,
    );
    expect(result.rows).toEqual([]);
  });

  it('refuses to delete a source document that something still cites', async () => {
    const restricting = await database.query<{ n: number }>(
      `select count(*)::int as n
       from information_schema.referential_constraints rc
       join information_schema.key_column_usage k
         on k.constraint_name = rc.constraint_name
       where k.column_name = 'source_document_id' and rc.delete_rule <> 'RESTRICT'`,
    );
    expect(restricting.rows[0]?.n).toBe(0);
  });

  it('versions a source document rather than overwriting its content hash', async () => {
    const onDocument = await database.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'source_documents' and column_name = 'content_hash'`,
    );
    expect(onDocument.rows).toEqual([]);

    const onVersion = await database.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_name = 'source_document_versions' and column_name = 'content_hash'`,
    );
    expect(onVersion.rows[0]?.is_nullable).toBe('NO');
  });

  it('keys an observation to a document version, not to a URL', async () => {
    const result = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'source_observations_unique_field'`,
    );
    expect(result.rows[0]?.definition).toContain('source_document_version_id');
  });

  it('gives an organization a unique identity fingerprint', async () => {
    const result = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'organizations'::regclass and contype = 'u'`,
    );
    expect(result.rows.map((row) => row.definition).join(' ')).toContain('identity_fingerprint');
  });

  it('never cascades a delete into the suppression list', async () => {
    const cascading = await database.query<{ n: number }>(
      `select count(*)::int as n
       from information_schema.referential_constraints rc
       join information_schema.table_constraints tc
         on tc.constraint_name = rc.constraint_name
       where tc.table_name = 'suppression_entries' and rc.delete_rule = 'CASCADE'`,
    );
    expect(cascading.rows[0]?.n).toBe(0);
  });
});

/**
 * Row level security.
 *
 * These assertions prove the schema-side half: every table has row level
 * security enabled and forced, and no policy exists to open it. They cannot
 * prove the PostgREST half, because PGlite has no `anon` or `authenticated`
 * role and no PostgREST in front of it. Confirming that an anonymous request
 * with a publishable key is refused needs a Supabase integration test against a
 * real project, which is tracked as a production blocker in docs/BACKLOG.md.
 */
describe('row level security', () => {
  it('is enabled and forced on every table in the public schema', async () => {
    const result = await database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    expect(result.rows.length).toBeGreaterThan(30);
    const unprotected = result.rows.filter(
      (row) => !row.relrowsecurity || !row.relforcerowsecurity,
    );
    expect(unprotected.map((row) => row.relname)).toEqual([]);
  });

  it('covers every table the platform declares, with none missed', async () => {
    const result = await database.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
    );
    const protectedTables = new Set(result.rows.map((row) => row.relname));
    for (const table of TABLE_NAMES) {
      expect(protectedTables.has(table), `${table} has no row level security`).toBe(true);
    }
  });

  it('has no policies at all, because default deny is the policy', async () => {
    // A permissive placeholder policy is worse than none: it reads as a
    // considered decision. Any policy added later needs its own migration and
    // its own review.
    const result = await database.query<{ policyname: string; tablename: string }>(
      `select policyname, tablename from pg_policies where schemaname = 'public'`,
    );
    expect(result.rows).toEqual([]);
  });
});
