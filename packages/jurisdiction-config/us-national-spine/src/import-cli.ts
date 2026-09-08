#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SourcePolicyRegistry, canonicalizeUrl, domainOf, urlHash } from '@public-workforce/core';
import {
  IngestionRepository,
  OrganizationSpineImportRepository,
  PostgresClient,
  SourcePolicyRepository,
  type SourceDocumentVersionRef,
  type StageOrganizationSpineRecord,
} from '@public-workforce/database';
import type { OrganizationSpineRecordStatus } from '@public-workforce/shared-types';
import { texasEducationJurisdiction } from '@public-workforce/jurisdiction-texas-education';
import {
  nationalOrganizationSpineInventory,
  type OrganizationSpineInventorySource,
} from './inventory.js';
import { durableSpineSourceRecordKey, type SpineSourceRecord } from './index.js';
import {
  ensureTexasEducationJurisdiction,
  materializeTexasEducationAttributes,
} from './materialize.js';

const argumentsSet = new Set(process.argv.slice(2));
const apply = argumentsSet.has('--apply');
const canonicalize = argumentsSet.has('--canonicalize');
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const directory = resolve(positional[0] ?? '.context/national-spine/organized');
const summaryPath = join(directory, 'summary.json');

if (!existsSync(summaryPath))
  throw new Error(`organization spine summary is missing: ${summaryPath}`);
interface LocalSummary {
  generatedAt: string;
  sources: Record<string, { records: number; websites: number; missingWebsites: number }>;
  texas: {
    districts: number;
    campuses: number;
    districtWebsites: number;
    campusWebsites: number;
    representedCounties: number;
    missingCounties: string[];
  };
}

const localSummary = JSON.parse(readFileSync(summaryPath, 'utf8')) as LocalSummary;
validateLocalSummary(localSummary);

if (!apply) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'plan_only',
        directory,
        generatedAt: localSummary.generatedAt,
        sourceRows: nationalOrganizationSpineInventory.sourceRows,
        canonicalizeRequested: canonicalize,
        nextCommand: 'pnpm spine:import -- --apply --canonicalize',
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
  throw new Error(
    '--apply requires DATABASE_URL; the importer never selects a database implicitly',
  );
}

const database = new PostgresClient({
  connectionString: databaseUrl,
  max: 2,
  statementTimeoutMs: 120_000,
});
try {
  await database.query('select 1 from organization_spine_records limit 1');
  const ingestion = new IngestionRepository(database);
  const repository = new OrganizationSpineImportRepository(database);
  const sourcePolicies = new SourcePolicyRegistry(
    await new SourcePolicyRepository(database).list(),
  );
  const jurisdictionIds = new Map<string, string>([
    ['us-tx-education', await ensureTexasEducationJurisdiction(database)],
  ]);
  const versionCache = new Map<string, SourceDocumentVersionRef>();
  let staged = 0;

  staged += await stageFile('organization-source-records.ndjson', (record) =>
    record.classificationReviewReason === null &&
    record.organizationTypeCode !== null &&
    record.governmentLevelCode !== null &&
    record.sectorCode !== null &&
    record.identifiers.length > 0
      ? 'ready_to_import'
      : 'classification_hold',
  );
  staged += await stageFile('organization-overlays.ndjson', (record) =>
    record.classificationReviewReason === null &&
    record.organizationTypeCode !== null &&
    record.governmentLevelCode !== null &&
    record.sectorCode !== null &&
    record.identifiers.length > 0
      ? 'ready_to_import'
      : 'overlay_hold',
  );
  staged += await stageFile('reconciliation-required.ndjson', () => 'reconciliation_hold');

  let imported = 0;
  let relationships = { materialized: 0, unresolved: 0 };
  let educationAttributes = 0;
  if (canonicalize) {
    for (;;) {
      const count = await repository.canonicalizeReady(5_000);
      imported += count;
      if (count === 0) break;
      process.stdout.write(`canonicalized ${imported.toLocaleString()} ready rows\n`);
    }
    relationships = await repository.materializeRelationships();
    educationAttributes = await materializeTexasEducationAttributes(database);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'applied',
        staged,
        imported,
        relationships,
        educationAttributes,
        database: await repository.summary(),
      },
      null,
      2,
    )}\n`,
  );

  async function stageFile(
    filename: string,
    statusFor: (record: SpineSourceRecord) => OrganizationSpineRecordStatus,
  ): Promise<number> {
    const path = join(directory, filename);
    if (!existsSync(path)) throw new Error(`organization spine artifact is missing: ${path}`);
    const contentHash = await sha256File(path);
    const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let batch: StageOrganizationSpineRecord[] = [];
    let count = 0;
    for await (const line of input) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as SpineSourceRecord;
      const version = await sourceVersion(record.sourceKey, filename, contentHash);
      batch.push({
        sourceKey: record.sourceKey,
        sourceRecordKey: durableSpineSourceRecordKey(record),
        name: record.name,
        nameNormalized: record.nameNormalized,
        organizationTypeCode: record.organizationTypeCode,
        governmentLevelCode: record.governmentLevelCode,
        sectorCode: record.sectorCode,
        classificationReviewReason: record.classificationReviewReason,
        jurisdictionId:
          record.jurisdictionCode === null ? null : requireJurisdictionId(record.jurisdictionCode),
        websiteValueRaw: record.website?.publishedValue ?? null,
        websiteUrl: record.website?.canonicalUrl ?? null,
        primaryDomain: record.website?.primaryDomain ?? null,
        identifiers: record.identifiers,
        parentIdentifiers: record.parentIdentifiers,
        location: { ...record.location },
        attributes: record.attributes,
        status: statusFor(record),
        sourceDocumentId: version.documentId,
        sourceDocumentVersionId: version.versionId,
        sourceEffectiveDate: record.sourceEffectiveDate,
        observedAt: localSummary.generatedAt,
      });
      if (batch.length === 2_000) {
        count += await repository.stage(batch);
        batch = [];
        if (count % 10_000 === 0)
          process.stdout.write(`${filename}: staged ${count.toLocaleString()}\n`);
      }
    }
    count += await repository.stage(batch);
    process.stdout.write(`${filename}: staged ${count.toLocaleString()}\n`);
    return count;
  }

  function requireJurisdictionId(code: string): string {
    const id = jurisdictionIds.get(code);
    if (id === undefined) throw new Error(`spine record names an unknown jurisdiction: ${code}`);
    return id;
  }

  async function sourceVersion(
    sourceKey: string,
    filename: string,
    contentHash: string,
  ): Promise<SourceDocumentVersionRef> {
    const cached = versionCache.get(`${sourceKey}:${filename}`);
    if (cached !== undefined) return cached;
    const source = sourceInventory(sourceKey);
    const canonicalUrl = canonicalizeUrl(source.catalogUrl);
    const domain = canonicalUrl === null ? null : domainOf(canonicalUrl);
    if (canonicalUrl === null || domain === null) {
      throw new Error(`source inventory has an unusable catalog URL: ${source.key}`);
    }
    const policy = sourcePolicies.assertCollectable(canonicalUrl, 'production');
    const version = await ingestion.recordSourceDocument({
      url: source.catalogUrl,
      urlCanonical: canonicalUrl,
      urlHash: urlHash(canonicalUrl),
      domain,
      sourceTypeCode: 'bulk_dataset',
      httpStatus: 200,
      contentHash,
      contentType: 'application/x-ndjson',
      storageKey: `national-spine/${basename(filename)}`,
      robotsAllowed: null,
      robotsPolicyNote: 'Imported from a locally preserved official bulk release.',
      sourcePolicyId: policy.policyId,
      crawlRunId: null,
      retrievedAt: localSummary.generatedAt,
    });
    versionCache.set(`${sourceKey}:${filename}`, version);
    return version;
  }
} finally {
  await database.close();
}

function sourceInventory(sourceKey: string): OrganizationSpineInventorySource {
  const exact = nationalOrganizationSpineInventory.sources.find(
    (source) => source.key === sourceKey,
  );
  if (exact !== undefined) return exact;
  const prefix = nationalOrganizationSpineInventory.sources.find((source) =>
    sourceKey.startsWith(source.key.split(':')[0] as string),
  );
  if (prefix !== undefined) return prefix;
  throw new Error(`source key is absent from the reviewed inventory: ${sourceKey}`);
}

function validateLocalSummary(summary: LocalSummary): void {
  for (const source of nationalOrganizationSpineInventory.sources) {
    const actual = summary.sources[source.key];
    if (
      actual === undefined ||
      actual.records !== source.records ||
      actual.websites !== source.publishedWebsites ||
      actual.missingWebsites !== source.missingWebsites
    ) {
      throw new Error(`organized counts differ from the reviewed inventory: ${source.key}`);
    }
  }

  const texas = summary.texas;
  if (texas == null) throw new Error('organized summary is missing Texas reconciliation counts');
  const texasInventory = sourceInventory('texas-askted-site-2026');
  const expectedAreaCount = texasEducationJurisdiction.expectedAreaCount;
  if (
    texas.districts + texas.campuses !== texasInventory.records ||
    texas.districtWebsites + texas.campusWebsites !== texasInventory.publishedWebsites ||
    expectedAreaCount === null ||
    texas.representedCounties + texas.missingCounties.length !== expectedAreaCount
  ) {
    throw new Error('organized Texas coverage does not reconcile to its reviewed baseline');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
