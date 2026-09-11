#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PostgresClient, type SqlClient } from '@public-workforce/database';
import {
  TexasEducationOrganizationIndex,
  prepareLegacyContact,
  streamLegacyContactLines,
  validateLegacyContactManifest,
  type LegacyContactManifest,
  type LegacyContactRow,
  type PreparedLegacyContact,
  type TexasEducationOrganizationCandidate,
} from './legacy-contact-import.js';
import {
  importPreparedLegacyContact,
  recordLegacyArtifact,
  seedLegacyRevalidationTarget,
} from './legacy-contact-persistence.js';

interface ImportCheckpoint {
  schemaVersion: 1;
  artifactId: string;
  mode: string;
  files: Record<string, { sha256: string; completedLine: number }>;
}

interface ImportCounts {
  read: number;
  accepted: number;
  quarantined: number;
  imported: number;
  revalidationQueued: number;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const seedRevalidation = args.includes('--seed-revalidation');
if (apply && seedRevalidation)
  throw new Error('--apply and --seed-revalidation are mutually exclusive modes');
const valuedOptions = new Set(['--checkpoint', '--quarantine', '--revalidation']);
const positional = args.filter(
  (value, index) => !value.startsWith('--') && !valuedOptions.has(args[index - 1] ?? ''),
);
const manifestPath = resolve(positional[0] ?? 'legacy-contact-manifest.json');
const mode = apply ? 'apply' : seedRevalidation ? 'seed-revalidation' : 'dry-run';
const checkpointPath = resolve(option('--checkpoint') ?? `${manifestPath}.${mode}.checkpoint.json`);
const quarantinePath = resolve(
  option('--quarantine') ?? `${manifestPath}.${mode}.quarantine.ndjson`,
);
const revalidationPath = resolve(
  option('--revalidation') ?? `${manifestPath}.${mode}.revalidation.ndjson`,
);

const manifest = validateLegacyContactManifest(
  JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
);
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl.trim().length === 0)
  throw new Error('DATABASE_URL is required for exact organization matching');
if (
  (apply || seedRevalidation) &&
  manifest.files.some(
    (file) =>
      (file.archiveStorageKey === undefined || file.archiveStorageKey.trim().length === 0) &&
      file.archiveUrl === undefined,
  )
)
  throw new Error(
    `${mode} requires archiveStorageKey or immutable archiveUrl for every input. The accepted export must be durable evidence; a source page URL is not proof that its raw page was archived.`,
  );

const database = new PostgresClient({
  connectionString: databaseUrl,
  max: 2,
  statementTimeoutMs: 120_000,
});
try {
  const index = new TexasEducationOrganizationIndex(await loadTexasOrganizations(database));
  const approvedDomains = await loadApprovedDomains(manifestPath, manifest);
  const checkpoint = await loadCheckpoint(checkpointPath, manifest.artifactId, mode);
  const counts: ImportCounts = {
    read: 0,
    accepted: 0,
    quarantined: 0,
    imported: 0,
    revalidationQueued: 0,
  };
  const quarantineOutputKeys = await loadOutputKeys(quarantinePath);
  const revalidationOutputKeys = await loadOutputKeys(revalidationPath);
  for (const file of manifest.files) {
    const path = isAbsolute(file.path) ? file.path : resolve(dirname(manifestPath), file.path);
    if (!existsSync(path)) throw new Error(`manifest input does not exist: ${path}`);
    const actualHash = await sha256File(path);
    if (actualHash !== file.sha256.toLowerCase())
      throw new Error(`manifest sha256 does not match input: ${path}`);
    const prior = checkpoint.files[path];
    if (prior !== undefined && prior.sha256 !== actualHash)
      throw new Error(`checkpoint belongs to different content: ${path}`);
    const resumeAfter = prior?.completedLine ?? 0;
    const artifactSource =
      apply || seedRevalidation
        ? await recordLegacyArtifact(
            database,
            file,
            manifest.artifactId,
            actualHash,
            manifest.createdAt,
          )
        : null;
    let pending: { lineNumber: number; record: PreparedLegacyContact }[] = [];
    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      if (apply) {
        if (artifactSource === null) throw new Error('apply requires archived artifact provenance');
        await database.transaction(async (tx) => {
          for (const item of pending)
            await importPreparedLegacyContact(tx, item.record, artifactSource, {
              artifactId: manifest.artifactId,
              archiveReference: file.archiveStorageKey ?? file.archiveUrl!,
              sha256: actualHash,
            });
        });
        counts.imported += pending.length;
      } else if (seedRevalidation) {
        if (artifactSource === null)
          throw new Error('revalidation target requires archived artifact provenance');
        await database.transaction(async (tx) => {
          for (const item of pending)
            await seedLegacyRevalidationTarget(tx, item.record, artifactSource.documentId);
        });
        counts.revalidationQueued += pending.length;
      }
      if (!apply) {
        for (const item of pending)
          await appendLineOnce(
            revalidationPath,
            {
              artifactId: manifest.artifactId,
              file: path,
              line: item.lineNumber,
              organizationId: item.record.organizationId,
              district: item.record.districtPublished,
              school: item.record.schoolPublished,
              sourcePageUrl: item.record.sourcePageUrl,
              reason: seedRevalidation
                ? 'legacy accepted row queued for live revalidation'
                : 'legacy accepted row requires archived file import or live revalidation',
            },
            `${path}:${item.lineNumber}`,
            revalidationOutputKeys,
          );
      }
      const completedLine = pending.at(-1)!.lineNumber;
      pending = [];
      await saveProgress(checkpointPath, checkpoint, path, actualHash, completedLine);
    };
    for await (const { lineNumber, line } of streamLegacyContactLines(path)) {
      if (lineNumber <= resumeAfter || line.trim().length === 0) continue;
      counts.read += 1;
      let row: LegacyContactRow;
      try {
        row = JSON.parse(line) as LegacyContactRow;
      } catch {
        await flushPending();
        await appendLineOnce(
          quarantinePath,
          { file: path, line: lineNumber, reason: 'invalid JSON' },
          `${path}:${lineNumber}`,
          quarantineOutputKeys,
        );
        counts.quarantined += 1;
        await saveProgress(checkpointPath, checkpoint, path, actualHash, lineNumber);
        continue;
      }
      const disposition = prepareLegacyContact(
        row,
        index,
        manifest.artifactId,
        lineNumber,
        approvedDomains,
      );
      if (disposition.status === 'quarantined') {
        await flushPending();
        await appendLineOnce(
          quarantinePath,
          {
            file: path,
            line: lineNumber,
            reason: disposition.reason,
            district: stringValue(row.district),
            school: stringValue(row.school),
            sourcePageUrl: stringValue(row.directory_url) || stringValue(row.data_source_url),
          },
          `${path}:${lineNumber}`,
          quarantineOutputKeys,
        );
        counts.quarantined += 1;
        await saveProgress(checkpointPath, checkpoint, path, actualHash, lineNumber);
      } else {
        counts.accepted += 1;
        pending.push({ lineNumber, record: disposition.record });
        if (pending.length === 250) await flushPending();
      }
    }
    await flushPending();
  }
  process.stdout.write(`${JSON.stringify({ mode, manifestPath, ...counts }, null, 2)}\n`);
} finally {
  await database.close();
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function loadApprovedDomains(
  manifestPath: string,
  manifest: LegacyContactManifest,
): Promise<ReadonlySet<string>> {
  const path = isAbsolute(manifest.approvedDomainAllowlistPath)
    ? manifest.approvedDomainAllowlistPath
    : resolve(dirname(manifestPath), manifest.approvedDomainAllowlistPath);
  if (!existsSync(path)) throw new Error(`approved domain allowlist does not exist: ${path}`);
  const actualHash = await sha256File(path);
  if (actualHash !== manifest.approvedDomainAllowlistSha256.toLowerCase())
    throw new Error('approved domain allowlist sha256 does not match manifest');
  const domains = (await fs.readFile(path, 'utf8'))
    .split(/\r?\n/)
    .map((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, ''),
    )
    .filter(Boolean);
  if (domains.length === 0 || domains.some((domain) => !/^[a-z0-9.-]+$/.test(domain)))
    throw new Error('approved domain allowlist is empty or malformed');
  return new Set(domains);
}

async function loadTexasOrganizations(
  client: SqlClient,
): Promise<TexasEducationOrganizationCandidate[]> {
  const result = await client.query<{
    organization_id: string;
    school_name: string;
    district_name: string;
  }>(
    `select distinct school.id as organization_id, school.name as school_name, district.name as district_name
     from organizations school
     join organization_relationships relationship
       on relationship.child_organization_id = school.id
      and relationship.effective_from <= current_date
      and (relationship.effective_to is null or relationship.effective_to >= current_date)
     join organizations district on district.id = relationship.parent_organization_id
     left join jurisdictions jurisdiction on jurisdiction.id = school.jurisdiction_id
     where school.organization_type_code = 'school'
       and school.sector_code = 'education'
       and district.organization_type_code = 'school_district'
       and (jurisdiction.code = 'us-tx-education' or exists (
         select 1 from organization_locations location
         where location.organization_id = school.id and location.state_code = 'TX'
       ))`,
  );
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    schoolName: row.school_name,
    districtName: row.district_name,
  }));
}

async function loadCheckpoint(
  path: string,
  artifactId: string,
  mode: string,
): Promise<ImportCheckpoint> {
  if (!existsSync(path)) return { schemaVersion: 1, artifactId, mode, files: {} };
  const value = JSON.parse(await fs.readFile(path, 'utf8')) as ImportCheckpoint;
  if (value.schemaVersion !== 1 || value.artifactId !== artifactId || value.mode !== mode)
    throw new Error('checkpoint does not belong to this manifest');
  return value;
}

async function saveProgress(
  path: string,
  checkpoint: ImportCheckpoint,
  file: string,
  sha256: string,
  completedLine: number,
): Promise<void> {
  checkpoint.files[file] = { sha256, completedLine };
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await fs.rename(temporary, path);
}

async function appendLineOnce(
  path: string,
  value: unknown,
  key: string,
  existing: Set<string>,
): Promise<void> {
  if (existing.has(key)) return;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(value)}\n`);
  existing.add(key);
}

async function loadOutputKeys(path: string): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!existsSync(path)) return keys;
  const content = await fs.readFile(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { file?: unknown; line?: unknown };
    if (typeof row.file === 'string' && typeof row.line === 'number')
      keys.add(`${row.file}:${row.line}`);
  }
  return keys;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
