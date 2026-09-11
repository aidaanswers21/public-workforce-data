#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PostgresClient } from '@public-workforce/database';
import {
  streamLegacyContactLines,
  validateLegacyContactManifest,
  type LegacyContactManifest,
} from './legacy-contact-import.js';
import {
  planUncoveredCampusTargets,
  seedUncoveredCampusTargets,
} from './uncovered-campus-targets.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(
  (value, index) => !value.startsWith('--') && args[index - 1] !== '--actor',
);
const manifestPath = resolve(
  positional[0] ?? 'data/texas/legacy-contacts/legacy-contact-manifest.json',
);
const projectId = positional[1];
if (projectId === undefined || !UUID.test(projectId))
  throw new Error('a collection project UUID is required');
const actor = option('--actor');
if (apply && (actor === undefined || actor.trim().length === 0))
  throw new Error('--actor is required with --apply');
const applyActor = actor ?? '';
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl.trim().length === 0)
  throw new Error('DATABASE_URL is required');

const manifest = validateLegacyContactManifest(
  JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
);
const approvedDomains = await loadApprovedDomains(manifestPath, manifest);
const expectedArtifactRecords = await verifyAndCountArtifactRecords(manifestPath, manifest);
const database = new PostgresClient({
  connectionString: databaseUrl,
  max: 2,
  statementTimeoutMs: 120_000,
});
try {
  const result = apply
    ? await seedUncoveredCampusTargets(database, {
        projectId,
        artifactId: manifest.artifactId,
        expectedArtifactRecords,
        approvedDomains,
        actor: applyActor,
      })
    : await planUncoveredCampusTargets(database, {
        projectId,
        artifactId: manifest.artifactId,
        approvedDomains,
      });
  process.stdout.write(
    `${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2)}\n`,
  );
} finally {
  await database.close();
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function loadApprovedDomains(
  sourceManifestPath: string,
  manifest: LegacyContactManifest,
): Promise<ReadonlySet<string>> {
  const path = isAbsolute(manifest.approvedDomainAllowlistPath)
    ? manifest.approvedDomainAllowlistPath
    : resolve(dirname(sourceManifestPath), manifest.approvedDomainAllowlistPath);
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolveHash);
    stream.on('error', reject);
  });
  if (hash.digest('hex') !== manifest.approvedDomainAllowlistSha256.toLowerCase())
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

async function verifyAndCountArtifactRecords(
  sourceManifestPath: string,
  manifest: LegacyContactManifest,
): Promise<number> {
  let count = 0;
  for (const file of manifest.files) {
    const path = isAbsolute(file.path)
      ? file.path
      : resolve(dirname(sourceManifestPath), file.path);
    const hash = createHash('sha256');
    await new Promise<void>((resolveHash, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolveHash);
      stream.on('error', reject);
    });
    if (hash.digest('hex') !== file.sha256.toLowerCase())
      throw new Error(`manifest sha256 does not match input: ${path}`);
    for await (const { line } of streamLegacyContactLines(path))
      if (line.trim().length > 0) count += 1;
  }
  if (count < 1) throw new Error('manifest artifact contains no records');
  return count;
}
