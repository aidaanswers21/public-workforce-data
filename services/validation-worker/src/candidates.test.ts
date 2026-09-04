import { afterEach, describe, expect, it } from 'vitest';
import {
  IngestionRepository,
  OrganizationRepository,
  QueryRepository,
  TestDatabase,
} from '@public-workforce/database';
import { createSilentLogger } from '@public-workforce/observability';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import type { Uuid } from '@public-workforce/shared-types';
import { CandidateGenerator } from './candidates.js';

const AT = '2026-06-01T00:00:00.000Z';
const DOMAIN = 'agency.example.gov';

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

interface World {
  database: TestDatabase;
  generator: CandidateGenerator;
  organizationId: Uuid;
  documentId: Uuid;
  ingestion: IngestionRepository;
  addPerson: (name: string, address: string | null) => Promise<Uuid>;
}

/**
 * A real organization with real published addresses.
 *
 * Against real PostgreSQL, because the defect this covers was a parameter list
 * one shorter than its placeholders. Nothing but a database executing the
 * statement would have caught it.
 */
async function world(): Promise<World> {
  const database = await TestDatabase.create({ sectors: [federalGovernmentSectorPack] });
  open = database;
  const ingestion = new IngestionRepository(database);
  const organizations = new OrganizationRepository(database);
  const queries = new QueryRepository(database);

  const document = await ingestion.recordSourceDocument({
    url: `https://${DOMAIN}/staff`,
    urlCanonical: `https://${DOMAIN}/staff`,
    urlHash: 'staff',
    domain: DOMAIN,
    sourceTypeCode: 'html_directory',
    httpStatus: 200,
    contentHash: 'content-1',
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: null,
    crawlRunId: null,
    retrievedAt: AT,
  });

  const jurisdictionId = await organizations.upsertJurisdiction({
    code: 'us-federal',
    name: 'United States',
    governmentLevelCode: 'federal',
  });

  const created = await organizations.upsertOrganization({
    organizationTypeCode: 'federal_agency',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    jurisdictionId,
    name: 'Sample Agency',
    nameNormalized: 'sample-agency',
    primaryDomain: DOMAIN,
    sourceDocumentId: document.documentId,
    extractionMethod: 'html_table',
    confidence: 0.9,
    observedAt: AT,
  });

  let counter = 0;
  const addPerson = async (name: string, address: string | null): Promise<Uuid> => {
    counter += 1;
    const [first = '', last = ''] = name.split(' ');
    const result = await ingestion.ingestPerson({
      recordKey: `record:${counter}`,
      organizationId: created.id,
      organizationalUnitId: null,
      dutyLocationId: null,
      fullNamePublished: name,
      nameParts: { prefix: null, firstName: first, middleName: null, lastName: last, suffix: null },
      identityKey: `${created.id}|${last.toLowerCase()}-${first.toLowerCase()}`,
      titlePublished: 'Analyst',
      titleNormalized: 'Analyst',
      roleCategoryCode: 'other',
      jobFamilyCode: 'other',
      seniorityCode: 'staff',
      specialty: null,
      normalizationMethod: 'rule_table',
      normalizationRuleSource: 'base',
      taxonomyVersion: 'test',
      normalizationConfidence: 0.5,
      departmentPublished: null,
      emails:
        address === null
          ? []
          : [
              {
                address,
                addressNormalized: address,
                domain: DOMAIN,
                localPart: address.split('@')[0] ?? '',
                classification: 'published',
                obfuscation: 'none',
                sourceValue: address,
              },
            ],
      sourceDocumentId: document.documentId,
      crawlRunId: null,
      extractionMethod: 'html_table',
      confidence: 0.9,
      observedAt: AT,
    });
    return result.personId;
  };

  return {
    database,
    ingestion,
    organizationId: created.id,
    documentId: document.documentId,
    addPerson,
    generator: new CandidateGenerator({
      client: database,
      queries,
      logger: createSilentLogger(),
    }),
  };
}

/** Enough published examples for `first.last@` to be learnable. */
async function seedPattern(w: World): Promise<void> {
  await w.addPerson('Jane Smith', `jane.smith@${DOMAIN}`);
  await w.addPerson('Ravi Patel', `ravi.patel@${DOMAIN}`);
  await w.addPerson('Dana Lee', `dana.lee@${DOMAIN}`);
  await w.addPerson('Omar Haddad', `omar.haddad@${DOMAIN}`);
}

describe('CandidateGenerator', () => {
  it('creates a candidate for someone with no published address', async () => {
    const w = await world();
    await seedPattern(w);
    const targetId = await w.addPerson('Alex Moreno', null);

    const summary = await w.generator.generateForScope(
      { governmentLevelCode: 'federal' },
      { minSupport: 3 },
    );

    expect(summary.domainsExamined).toBe(1);
    expect(summary.patternsLearned).toBe(1);
    expect(summary.candidatesCreated).toBe(1);

    const rows = await w.database.query<Record<string, unknown>>(
      'select * from email_candidates where person_id = $1',
      [targetId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.['address']).toBe(`alex.moreno@${DOMAIN}`);
  });

  it('binds the organization, rather than shifting every parameter after it', async () => {
    // The defect: eleven placeholders, nine parameters, `organization_id`
    // never bound. The organization column received a domain string, so this
    // statement could not execute at all against real PostgreSQL.
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);

    await w.generator.generateForScope({}, { minSupport: 3 });

    const row = await w.database.query<{ organization_id: Uuid | null; domain: string }>(
      'select organization_id, domain from email_candidates limit 1',
    );
    expect(row.rows[0]?.organization_id).toBe(w.organizationId);
    expect(row.rows[0]?.domain).toBe(DOMAIN);
  });

  it('preserves the pattern and the evidence that justified it', async () => {
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);

    await w.generator.generateForScope({}, { minSupport: 3 });

    const row = await w.database.query<{
      pattern: string;
      supporting_examples: unknown;
      support_count: number;
      conflict_count: number;
      consistency: string;
      confidence: string;
    }>(
      `select pattern, supporting_examples, support_count, conflict_count, consistency, confidence
       from email_candidates limit 1`,
    );
    const candidate = row.rows[0];
    expect(candidate?.pattern).toBeTruthy();
    expect(Number(candidate?.support_count)).toBeGreaterThanOrEqual(3);
    expect(Number(candidate?.conflict_count)).toBe(0);
    expect(Number(candidate?.consistency)).toBeGreaterThan(0);
    // Confidence is a real number, not the null a shifted parameter list left.
    expect(Number(candidate?.confidence)).toBeGreaterThan(0);

    const examples =
      typeof candidate?.supporting_examples === 'string'
        ? (JSON.parse(candidate.supporting_examples) as unknown[])
        : (candidate?.supporting_examples as unknown[]);
    expect(examples.length).toBeGreaterThanOrEqual(3);

    // And the domain pattern itself is stored, not only the candidate.
    const pattern = await w.database.query<{ n: number }>(
      'select count(*)::int as n from domain_email_patterns where domain = $1',
      [DOMAIN],
    );
    expect(pattern.rows[0]?.n).toBe(1);
  });

  it('is idempotent: a second run creates no new rows', async () => {
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);

    await w.generator.generateForScope({}, { minSupport: 3 });
    const afterFirst = await w.database.count('email_candidates');
    await w.generator.generateForScope({}, { minSupport: 3 });

    expect(await w.database.count('email_candidates')).toBe(afterFirst);
    expect(await w.database.count('domain_email_patterns')).toBe(1);
  });

  it('never writes an inferred address into email_addresses', async () => {
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);
    await w.generator.generateForScope({}, { minSupport: 3 });

    const inferred = await w.database.count(
      'email_addresses',
      "address_normalized like 'alex.moreno@%'",
    );
    expect(inferred).toBe(0);
  });

  it('leaves a candidate unpromoted without a valid validation result', async () => {
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);
    await w.generator.generateForScope({}, { minSupport: 3 });

    const state = await w.database.query<{ state: string; validation_status: string }>(
      'select state, validation_status from email_candidates limit 1',
    );
    expect(state.rows[0]?.state).toBe('pending');
    expect(state.rows[0]?.validation_status).toBe('unvalidated');

    // And the database refuses a promotion nobody validated.
    await expect(
      w.database.query(`update email_candidates set state = 'promoted'`),
    ).rejects.toThrow(/promotion_requires_validation/);
  });

  it('skips someone who already has a published address', async () => {
    const w = await world();
    await seedPattern(w);

    const summary = await w.generator.generateForScope({}, { minSupport: 3 });
    expect(summary.candidatesCreated).toBe(0);
    expect(await w.database.count('email_candidates')).toBe(0);
  });

  it('learns nothing from a domain with too few examples', async () => {
    const w = await world();
    await w.addPerson('Jane Smith', `jane.smith@${DOMAIN}`);
    await w.addPerson('Alex Moreno', null);

    const summary = await w.generator.generateForScope({}, { minSupport: 5 });
    expect(summary.patternsLearned).toBe(0);
    expect(summary.candidatesCreated).toBe(0);
  });

  it('scopes by level and sector, never by state', async () => {
    // A federal agency has no state, so a state filter would reach nothing.
    const w = await world();
    await seedPattern(w);
    await w.addPerson('Alex Moreno', null);

    const wrongLevel = await w.generator.generateForScope(
      { governmentLevelCode: 'county' },
      { minSupport: 3 },
    );
    expect(wrongLevel.domainsExamined).toBe(0);

    const rightLevel = await w.generator.generateForScope(
      { governmentLevelCode: 'federal', sectorCode: 'general_government' },
      { minSupport: 3 },
    );
    expect(rightLevel.candidatesCreated).toBe(1);
  });
});
