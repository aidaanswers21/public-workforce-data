import { afterEach, describe, expect, it } from 'vitest';
import { parsePersonName, personIdentityKey } from '@pan/core';
import type { Uuid } from '@pan/shared-types';
import { TestDatabase } from '../testing.js';
import { IngestionRepository, type IngestPersonInput } from './ingestion.js';
import { ComplianceRepository } from './compliance.js';
import { QueryRepository } from './queries.js';
import { ExportRepository } from './exports.js';

const AT = '2026-06-01T00:00:00.000Z';
/** Before AT, so a suppression added in a test is already in force when queried at AT. */
const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';

interface Seed {
  database: TestDatabase;
  ingestion: IngestionRepository;
  compliance: ComplianceRepository;
  queries: QueryRepository;
  stateId: Uuid;
  districtId: Uuid;
  schoolId: Uuid;
  sourcePageId: Uuid;
}

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function seed(): Promise<Seed> {
  const database = await TestDatabase.create();
  open = database;
  const ingestion = new IngestionRepository(database);

  const sourcePageId = await ingestion.upsertSourcePage({
    url: 'https://sample-isd.example.org/staff-directory',
    urlCanonical: 'https://sample-isd.example.org/staff-directory',
    urlHash: 'hash-directory',
    domain: 'sample-isd.example.org',
    sourceType: 'district_site',
    httpStatus: 200,
    contentHash: 'content-1',
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: null,
    crawlRunId: null,
    fetchedAt: AT,
  });

  const state = await database.query<{ id: Uuid }>(
    `insert into states (code, name, config_key) values ('TX','Texas','texas') returning id`,
  );
  const stateId = state.rows[0]!.id;

  const district = await database.query<{ id: Uuid }>(
    `insert into districts (state_id, name, name_normalized, source_page_id, extraction_method, confidence)
     values ($1,'Sample ISD','sample',$2,'manual',1) returning id`,
    [stateId, sourcePageId],
  );
  const districtId = district.rows[0]!.id;

  const school = await database.query<{ id: Uuid }>(
    `insert into schools (district_id, state_id, name, name_normalized, source_page_id, extraction_method, confidence)
     values ($1,$2,'Sample High School','sample-high',$3,'manual',1) returning id`,
    [districtId, stateId, sourcePageId],
  );

  return {
    database,
    ingestion,
    compliance: new ComplianceRepository(database),
    queries: new QueryRepository(database),
    stateId,
    districtId,
    schoolId: school.rows[0]!.id,
    sourcePageId,
  };
}

function personInput(
  context: Seed,
  name: string,
  title: string,
  address: string,
): IngestPersonInput {
  const parsed = parsePersonName(name);
  return {
    recordKey: `record:${name}`,
    stateId: context.stateId,
    districtId: context.districtId,
    schoolId: context.schoolId,
    departmentId: null,
    fullNamePublished: name,
    nameParts: parsed,
    identityKey: personIdentityKey({ stateCode: 'TX', orgScopeId: context.districtId, parsed }),
    titlePublished: title,
    titleNormalized: title,
    roleCategory: 'teacher',
    seniority: 'staff',
    specialty: null,
    emails: [
      {
        address,
        addressNormalized: address.toLowerCase(),
        domain: address.split('@')[1]!,
        localPart: address.split('@')[0]!,
        classification: 'published',
        obfuscation: 'none',
        sourceValue: address,
      },
    ],
    sourcePageId: context.sourcePageId,
    crawlRunId: null,
    extractionMethod: 'html_table',
    confidence: 0.9,
    observedAt: AT,
  };
}

describe('IngestionRepository', () => {
  it('creates a person, an assignment and an address', async () => {
    const context = await seed();
    const result = await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    expect(result.personCreated).toBe(true);
    expect(await context.database.count('people')).toBe(1);
    expect(await context.database.count('employment_assignments')).toBe(1);
    expect(await context.database.count('email_addresses')).toBe(1);
  });

  it('ingesting the same record twice does not duplicate anything', async () => {
    const context = await seed();
    const input = personInput(
      context,
      'Jane Smith',
      'Math Teacher',
      'jane.smith@sample-isd.example.org',
    );
    const first = await context.ingestion.ingestPerson(input);
    const second = await context.ingestion.ingestPerson({
      ...input,
      observedAt: '2026-07-01T00:00:00.000Z',
    });

    expect(second.personId).toBe(first.personId);
    expect(second.personCreated).toBe(false);
    expect(await context.database.count('people')).toBe(1);
    expect(await context.database.count('employment_assignments')).toBe(1);
    expect(await context.database.count('email_addresses')).toBe(1);
  });

  it('widens the seen window on a recrawl instead of overwriting it', async () => {
    const context = await seed();
    const input = personInput(
      context,
      'Jane Smith',
      'Math Teacher',
      'jane.smith@sample-isd.example.org',
    );
    await context.ingestion.ingestPerson(input);
    await context.ingestion.ingestPerson({ ...input, observedAt: '2026-09-01T00:00:00.000Z' });

    const row = await context.database.query<{ first_seen_at: Date; last_seen_at: Date }>(
      'select first_seen_at, last_seen_at from people',
    );
    expect(new Date(row.rows[0]!.first_seen_at).toISOString()).toBe(AT);
    expect(new Date(row.rows[0]!.last_seen_at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('matches the same person across name variants via the identity key', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    await context.ingestion.ingestPerson(
      personInput(context, 'Smith, Jane M.', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    expect(await context.database.count('people')).toBe(1);
  });

  it('upgrades a decoded address to published but never the reverse', async () => {
    const context = await seed();
    const base = personInput(
      context,
      'Jane Smith',
      'Math Teacher',
      'jane.smith@sample-isd.example.org',
    );
    const decoded = {
      ...base,
      emails: [
        {
          ...base.emails[0]!,
          classification: 'decoded_published' as const,
          obfuscation: 'cloudflare_cfemail' as const,
        },
      ],
    };

    await context.ingestion.ingestPerson(decoded);
    expect(
      (
        await context.database.query<{ classification: string }>(
          'select classification from email_addresses',
        )
      ).rows[0]?.classification,
    ).toBe('decoded_published');

    await context.ingestion.ingestPerson(base);
    expect(
      (
        await context.database.query<{ classification: string }>(
          'select classification from email_addresses',
        )
      ).rows[0]?.classification,
    ).toBe('published');

    await context.ingestion.ingestPerson(decoded);
    expect(
      (
        await context.database.query<{ classification: string }>(
          'select classification from email_addresses',
        )
      ).rows[0]?.classification,
    ).toBe('published');
  });

  it('rejects an inferred classification in email_addresses at the database level', async () => {
    const context = await seed();
    const { personId } = await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    await expect(
      context.database.query(
        `insert into email_addresses (person_id, address, address_normalized, domain, local_part,
           classification, source_page_id, extraction_method)
         values ($1,'guess@x.example.org','guess@x.example.org','x.example.org','guess','inferred_candidate',$2,'manual')`,
        [personId, context.sourcePageId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a record with no provenance', async () => {
    const context = await seed();
    await expect(
      context.database.query(
        `insert into people (state_id, full_name_published, identity_key, extraction_method)
         values ($1,'Ghost Person','tx|nowhere|ghost','manual')`,
        [context.stateId],
      ),
    ).rejects.toThrow();
  });

  it('records observations idempotently, one row per field per page', async () => {
    const context = await seed();
    for (const value of ['Jane Smith', 'Jane Smith']) {
      await context.ingestion.recordObservation({
        sourcePageId: context.sourcePageId,
        crawlRunId: null,
        entityType: 'person',
        entityId: null,
        recordKey: 'record:1',
        field: 'full_name_published',
        valueRaw: value,
        valueNormalized: value.toLowerCase(),
        extractionMethod: 'html_table',
        confidence: 0.9,
        selector: 'table > tr',
        observedAt: AT,
      });
    }
    expect(await context.database.count('source_observations')).toBe(1);
  });
});

describe('ComplianceRepository', () => {
  it('records a complaint and the suppression it creates', async () => {
    const context = await seed();
    const result = await context.compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'Jane.Smith@Sample-ISD.example.org',
      reason: 'asked to be removed',
      createdBy: 'ops',
    });
    expect(result.suppressionEntryId).not.toBeNull();

    const entries = await context.compliance.loadActiveSuppressions();
    expect(entries[0]?.value).toBe('jane.smith@sample-isd.example.org');
    expect(entries[0]?.source).toBe('complaint');
  });

  it('will not let a suppression entry be edited', async () => {
    const context = await seed();
    const id = await context.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await expect(
      context.database.query('update suppression_entries set reason = $2 where id = $1', [
        id,
        'changed',
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('will not let a suppression entry be deleted', async () => {
    const context = await seed();
    const id = await context.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await expect(
      context.database.query('delete from suppression_entries where id = $1', [id]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('allows revocation and drops the entry from the active set', async () => {
    const context = await seed();
    const id = await context.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await context.compliance.revokeSuppression(id, 'confirmed in error', 'ops');
    expect(await context.compliance.loadActiveSuppressions()).toHaveLength(0);
    expect(await context.database.count('suppression_entries')).toBe(1);
  });

  it('keeps the audit trail append-only and verifiable', async () => {
    const context = await seed();
    await context.compliance.addSuppression({
      scope: 'email',
      value: 'a@x.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await context.compliance.addSuppression({
      scope: 'email',
      value: 'b@x.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });

    expect(await context.compliance.verifyAuditChain()).toEqual({ valid: true, brokenAtId: null });
    await expect(context.database.query('delete from audit_events')).rejects.toThrow(/append-only/);
    await expect(
      context.database.query("update audit_events set actor = 'someone else'"),
    ).rejects.toThrow(/append-only/);
  });
});

describe('QueryRepository and ExportRepository', () => {
  it('excludes suppressed people in SQL, before any export code runs', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    await context.ingestion.ingestPerson(
      personInput(context, 'Wei Chen', 'Science Teacher', 'wei.chen@sample-isd.example.org'),
    );

    expect(await context.queries.queryExportableRows(AT)).toHaveLength(2);

    await context.compliance.addSuppression({
      scope: 'email',
      value: 'wei.chen@sample-isd.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });
    const rows = await context.queries.queryExportableRows(AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publishedEmail).toBe('jane.smith@sample-isd.example.org');
  });

  it('applies a district opt-out to everyone in it', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    await context.compliance.addSuppression({
      scope: 'district',
      value: context.districtId,
      districtId: context.districtId,
      reason: 'district requested removal',
      source: 'legal_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });
    expect(await context.queries.queryExportableRows(AT)).toHaveLength(0);
  });

  it('builds an export, records the suppression check and audits it', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    await context.ingestion.ingestPerson(
      personInput(context, 'Wei Chen', 'Science Teacher', 'wei.chen@sample-isd.example.org'),
    );
    await context.compliance.addSuppression({
      scope: 'email',
      value: 'wei.chen@sample-isd.example.org',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });

    const exports = new ExportRepository(context.database);
    const built = await exports.buildPeopleExport({
      name: 'tx-sample',
      requestedBy: 'ops',
      filters: { stateCode: 'TX' },
    });

    expect(built.rowCount).toBe(1);
    expect(built.csv).toContain('jane.smith@sample-isd.example.org');
    expect(built.csv).not.toContain('wei.chen@sample-isd.example.org');

    const row = await context.database.query<{
      status: string;
      suppression_checked_at: Date | null;
      checksum: string;
    }>('select status, suppression_checked_at, checksum from exports where id = $1', [
      built.exportId,
    ]);
    expect(row.rows[0]?.status).toBe('completed');
    expect(row.rows[0]?.suppression_checked_at).not.toBeNull();
    expect(row.rows[0]?.checksum).toBe(built.checksum);

    expect(await context.database.count('audit_events', "action = 'export.completed'")).toBe(1);
  });

  it('a person suppressed after a previous export is absent from the next one', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    const exports = new ExportRepository(context.database);

    const first = await exports.buildPeopleExport({
      name: 'run-1',
      requestedBy: 'ops',
      filters: {},
    });
    expect(first.rowCount).toBe(1);

    await context.compliance.addSuppression({
      scope: 'email',
      value: 'jane.smith@sample-isd.example.org',
      reason: 'opt out',
      source: 'complaint',
      createdBy: 'ops',
    });

    const second = await exports.buildPeopleExport({
      name: 'run-2',
      requestedBy: 'ops',
      filters: {},
    });
    expect(second.rowCount).toBe(0);
    expect(second.csv).not.toContain('jane.smith@sample-isd.example.org');
  });

  it('omits shared inboxes unless they are asked for', async () => {
    const context = await seed();
    const input = personInput(
      context,
      'Front Office',
      'Main Line',
      'office@sample-isd.example.org',
    );
    await context.ingestion.ingestPerson({
      ...input,
      emails: [{ ...input.emails[0]!, classification: 'general_inbox' }],
    });
    expect(await context.queries.queryExportableRows(AT)).toHaveLength(0);
    expect(
      await context.queries.queryExportableRows(AT, { includeGeneralInboxes: true }),
    ).toHaveLength(1);
  });

  it('reports coverage counts for a state', async () => {
    const context = await seed();
    await context.ingestion.ingestPerson(
      personInput(context, 'Jane Smith', 'Math Teacher', 'jane.smith@sample-isd.example.org'),
    );
    const summary = await context.queries.coverageSummary('TX');
    expect(summary).toMatchObject({
      stateCode: 'TX',
      districts: 1,
      schools: 1,
      people: 1,
      publishedEmails: 1,
    });
  });
});
