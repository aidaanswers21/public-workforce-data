import { createHash } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SqlClient } from '@public-workforce/database';
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
import { importPreparedLegacyContact, recordLegacyArtifact } from './legacy-contact-persistence.js';

export const LEGACY_CONTACT_STARTUP_FLAG = 'STARTUP_LEGACY_CONTACT_IMPORT_ARTIFACT_ID';

export interface StartupLegacyContactImportResult {
  status: 'disabled' | 'already_complete' | 'completed';
  artifactId?: string;
  expectedRecords?: number;
  recordsPresentBefore?: number;
}

export interface StartupLegacyContactImportProgress {
  phase: 'preflight' | 'import';
  processed: number;
  imported: number;
  skipped: number;
  total?: number;
}

export async function runStartupLegacyContactImport(options: {
  client: SqlClient;
  manifestPath: string;
  requestedArtifactId?: string;
  batchSize?: number;
  progressInterval?: number;
  onProgress?: (progress: StartupLegacyContactImportProgress) => void;
}): Promise<StartupLegacyContactImportResult> {
  const requestedArtifactId = options.requestedArtifactId?.trim();
  if (requestedArtifactId === undefined || requestedArtifactId.length === 0)
    return { status: 'disabled' };
  if (!/^[a-zA-Z0-9._-]{3,120}$/.test(requestedArtifactId))
    throw new Error(`${LEGACY_CONTACT_STARTUP_FLAG} must contain an exact artifact ID`);

  const manifestPath = resolve(options.manifestPath);
  const manifest = validateLegacyContactManifest(
    JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
  );
  if (requestedArtifactId !== manifest.artifactId)
    throw new Error(
      `${LEGACY_CONTACT_STARTUP_FLAG} does not match the bundled manifest artifact ID`,
    );
  requireDurableEvidence(manifest);
  const approvedDomains = await loadApprovedDomains(manifestPath, manifest);
  const index = new TexasEducationOrganizationIndex(await loadTexasOrganizations(options.client));
  const verifiedFiles: Array<{
    path: string;
    sha256: string;
    file: LegacyContactManifest['files'][number];
  }> = [];
  let expectedRecords = 0;
  const progressInterval = options.progressInterval ?? 1000;
  if (!Number.isInteger(progressInterval) || progressInterval < 1)
    throw new Error('startup import progressInterval must be a positive whole number');

  // Validate every row before the first write. A deployment must not silently
  // turn a changed organization spine or damaged bundle into a partial import.
  for (const file of manifest.files) {
    const path = isAbsolute(file.path) ? file.path : resolve(dirname(manifestPath), file.path);
    if (!existsSync(path)) throw new Error(`manifest input does not exist: ${path}`);
    const sha256 = await sha256File(path);
    if (sha256 !== file.sha256.toLowerCase())
      throw new Error(`manifest sha256 does not match input: ${path}`);
    const exclusions = new Map((file.exclusions ?? []).map((value) => [value.lineNumber, value]));
    const exclusionsSeen = new Set<number>();
    for await (const { lineNumber, line } of streamLegacyContactLines(path)) {
      if (line.trim().length === 0) continue;
      const prepared = prepareLine(line, index, manifest, lineNumber, approvedDomains);
      const exclusion = exclusions.get(lineNumber);
      if (prepared.status === 'quarantined') {
        if (
          exclusion !== undefined &&
          exclusion.reason === prepared.reason &&
          exclusion.lineSha256.toLowerCase() === sha256Text(line)
        ) {
          exclusionsSeen.add(lineNumber);
          continue;
        }
        throw new Error(
          `startup import preflight rejected ${file.path}:${lineNumber}: ${prepared.reason}`,
        );
      }
      if (exclusion !== undefined)
        throw new Error(`declared exclusion is no longer rejected: ${file.path}:${lineNumber}`);
      expectedRecords += 1;
      reportProgress(options.onProgress, progressInterval, {
        phase: 'preflight',
        processed: expectedRecords,
        imported: 0,
        skipped: 0,
      });
    }
    if (exclusionsSeen.size !== exclusions.size)
      throw new Error(`startup import did not find every declared exclusion in ${file.path}`);
    verifiedFiles.push({ path, sha256, file });
  }
  if (expectedRecords === 0) throw new Error('startup import bundle contains no accepted records');

  options.onProgress?.({
    phase: 'preflight',
    processed: expectedRecords,
    imported: 0,
    skipped: 0,
    total: expectedRecords,
  });
  const completedRecordKeys = await loadImportedRecordKeys(options.client, manifest.artifactId);
  const recordsPresentBefore = completedRecordKeys.size;
  if (recordsPresentBefore === expectedRecords)
    return {
      status: 'already_complete',
      artifactId: manifest.artifactId,
      expectedRecords,
      recordsPresentBefore,
    };
  if (recordsPresentBefore > expectedRecords)
    throw new Error('database contains more artifact records than the verified bundle');

  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('startup import batchSize must be a whole number between 1 and 1000');

  let processed = 0;
  let imported = 0;
  let skipped = 0;

  for (const verified of verifiedFiles) {
    const artifactSource = await recordLegacyArtifact(
      options.client,
      verified.file,
      manifest.artifactId,
      verified.sha256,
      manifest.createdAt,
    );
    let pending: PreparedLegacyContact[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      await runTransaction(options.client, async (client) => {
        for (const record of batch) {
          await importPreparedLegacyContact(client, record, artifactSource, {
            artifactId: manifest.artifactId,
            archiveReference: verified.file.archiveStorageKey ?? verified.file.archiveUrl!,
            sha256: verified.sha256,
          });
        }
      });
      imported += batch.length;
      options.onProgress?.({
        phase: 'import',
        processed,
        imported,
        skipped,
        total: expectedRecords,
      });
    };
    for await (const { lineNumber, line } of streamLegacyContactLines(verified.path)) {
      if (line.trim().length === 0) continue;
      if (verified.file.exclusions?.some((value) => value.lineNumber === lineNumber)) continue;
      const prepared = prepareLine(line, index, manifest, lineNumber, approvedDomains);
      if (prepared.status === 'quarantined')
        throw new Error(
          `verified startup row changed during import at ${verified.file.path}:${lineNumber}`,
        );
      processed += 1;
      if (completedRecordKeys.has(prepared.record.recordKey)) {
        skipped += 1;
        reportProgress(options.onProgress, progressInterval, {
          phase: 'import',
          processed,
          imported,
          skipped,
          total: expectedRecords,
        });
        continue;
      }
      pending.push(prepared.record);
      if (pending.length >= batchSize) await flush();
    }
    await flush();
  }

  const recordsPresentAfter = await countImportedRecords(options.client, manifest.artifactId);
  if (recordsPresentAfter !== expectedRecords)
    throw new Error(
      `startup import did not reach its database completion invariant: expected ${expectedRecords}, found ${recordsPresentAfter}`,
    );
  return {
    status: 'completed',
    artifactId: manifest.artifactId,
    expectedRecords,
    recordsPresentBefore,
  };
}

function prepareLine(
  line: string,
  index: TexasEducationOrganizationIndex,
  manifest: LegacyContactManifest,
  lineNumber: number,
  approvedDomains: ReadonlySet<string>,
) {
  let row: LegacyContactRow;
  try {
    row = JSON.parse(line) as LegacyContactRow;
  } catch {
    return { status: 'quarantined' as const, reason: 'invalid JSON' };
  }
  return prepareLegacyContact(row, index, manifest.artifactId, lineNumber, approvedDomains);
}

async function countImportedRecords(client: SqlClient, artifactId: string): Promise<number> {
  return (await loadImportedRecordKeys(client, artifactId)).size;
}

async function loadImportedRecordKeys(
  client: SqlClient,
  artifactId: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ record_key: string }>(
    `select distinct record_key
       from source_observations
      where field = 'legacy_artifact_id'
        and value_normalized = $1
        and extraction_method_code = 'file_import'`,
    [artifactId],
  );
  return new Set(result.rows.map((row) => row.record_key));
}

function reportProgress(
  report: ((progress: StartupLegacyContactImportProgress) => void) | undefined,
  interval: number,
  progress: StartupLegacyContactImportProgress,
): void {
  if (progress.processed % interval === 0) report?.(progress);
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

async function loadApprovedDomains(
  manifestPath: string,
  manifest: LegacyContactManifest,
): Promise<ReadonlySet<string>> {
  const path = isAbsolute(manifest.approvedDomainAllowlistPath)
    ? manifest.approvedDomainAllowlistPath
    : resolve(dirname(manifestPath), manifest.approvedDomainAllowlistPath);
  if (!existsSync(path)) throw new Error(`approved domain allowlist does not exist: ${path}`);
  if ((await sha256File(path)) !== manifest.approvedDomainAllowlistSha256.toLowerCase())
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

function requireDurableEvidence(manifest: LegacyContactManifest): void {
  if (
    manifest.files.some(
      (file) =>
        (file.archiveStorageKey === undefined || file.archiveStorageKey.trim().length === 0) &&
        file.archiveUrl === undefined,
    )
  )
    throw new Error('startup import requires durable evidence for every manifest input');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function runTransaction<T>(
  client: SqlClient,
  run: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  if (client.transaction !== undefined) return client.transaction(run);
  await client.query('begin');
  try {
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
