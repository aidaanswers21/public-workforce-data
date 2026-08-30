import type { Taxonomy } from '@pan/taxonomy';
import { SENIORITY_LEVELS } from '@pan/taxonomy';
import type { SqlClient } from './client.js';

export interface SeedSummary {
  table: string;
  inserted: number;
}

/**
 * Load the controlled vocabularies into the database.
 *
 * This is why organization types, sectors, role categories, identifier systems
 * and source types are reference tables rather than enums: adding one is a row
 * here, seeded from `@pan/taxonomy`, and a registered sector pack brings its own
 * along automatically. No migration, no downtime, no schema change.
 *
 * Idempotent. Re-running updates names and descriptions and leaves codes alone,
 * because a code is a contract with every row that references it.
 */
export async function seedReferenceData(
  client: SqlClient,
  taxonomy: Taxonomy,
): Promise<SeedSummary[]> {
  const summaries: SeedSummary[] = [];

  const upsert = async (
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> => {
    for (const row of rows) {
      const placeholders = row.map((_value, index) => `$${index + 1}`).join(', ');
      const updates = columns
        .slice(1)
        .map((column) => `${column} = excluded.${column}`)
        .join(', ');
      await client.query(
        `insert into ${table} (${columns.join(', ')}) values (${placeholders})
         on conflict (code) do update set ${updates}`,
        row,
      );
    }
    summaries.push({ table, inserted: rows.length });
  };

  // Order matters: types reference levels and sectors, roles reference families.
  await upsert(
    'government_levels',
    ['code', 'name', 'description', 'sort_order'],
    taxonomy.governmentLevels.map((row, index) => [row.code, row.name, row.description, index]),
  );
  await upsert(
    'sectors',
    ['code', 'name', 'description'],
    taxonomy.sectors.map((row) => [row.code, row.name, row.description]),
  );
  await upsert(
    'organization_types',
    [
      'code',
      'name',
      'description',
      'government_level_code',
      'sector_code',
      'typically_subordinate',
    ],
    taxonomy.organizationTypes.map((row) => [
      row.code,
      row.name,
      row.description,
      row.governmentLevelCode,
      row.sectorCode,
      row.typicallySubordinate,
    ]),
  );
  await upsert(
    'relationship_types',
    ['code', 'name', 'description', 'reading_from_child', 'implies_subtree'],
    taxonomy.relationshipTypes.map((row) => [
      row.code,
      row.name,
      row.description,
      row.readingFromChild,
      row.impliesSubtree,
    ]),
  );
  await upsert(
    'geographic_area_types',
    ['code', 'name', 'description'],
    taxonomy.geographicAreaTypes.map((row) => [row.code, row.name, row.description]),
  );
  await upsert(
    'identifier_systems',
    ['code', 'name', 'description', 'applies_to', 'pattern', 'authority'],
    taxonomy.identifierSystems.map((row) => [
      row.code,
      row.name,
      row.description,
      row.appliesTo,
      row.pattern,
      row.authority,
    ]),
  );
  await upsert(
    'source_types',
    ['code', 'name', 'description'],
    taxonomy.sourceTypes.map((row) => [row.code, row.name, row.description]),
  );
  await upsert(
    'evidence_classes',
    ['code', 'name', 'description'],
    taxonomy.evidenceClasses.map((row) => [row.code, row.name, row.description]),
  );
  await upsert(
    'job_families',
    ['code', 'name', 'description'],
    taxonomy.jobFamilies.map((row) => [row.code, row.name, row.description]),
  );
  await upsert(
    'role_categories',
    ['code', 'name', 'description', 'job_family_code'],
    taxonomy.roleCategories.map((row) => [row.code, row.name, row.description, row.jobFamilyCode]),
  );
  await upsert(
    'seniority_levels',
    ['code', 'name', 'description', 'sort_order'],
    SENIORITY_LEVELS.map((row, index) => [row.code, row.name, row.description, index]),
  );
  await upsert(
    'contact_point_types',
    ['code', 'name', 'description'],
    taxonomy.contactPointTypes.map((row) => [row.code, row.name, row.description]),
  );

  return summaries;
}
