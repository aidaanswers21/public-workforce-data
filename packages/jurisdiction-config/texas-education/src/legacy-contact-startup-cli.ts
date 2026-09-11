#!/usr/bin/env node
import { resolve } from 'node:path';
import { PostgresClient } from '@public-workforce/database';
import {
  LEGACY_CONTACT_STARTUP_FLAG,
  runStartupLegacyContactImport,
} from './legacy-contact-startup-import.js';

const requestedArtifactId = process.env[LEGACY_CONTACT_STARTUP_FLAG];
if (requestedArtifactId === undefined || requestedArtifactId.trim().length === 0) {
  process.stdout.write('Legacy contact startup import is disabled.\n');
} else {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0)
    throw new Error(`DATABASE_URL is required when ${LEGACY_CONTACT_STARTUP_FLAG} is set`);
  const database = new PostgresClient({
    connectionString: databaseUrl,
    max: 2,
    statementTimeoutMs: 120_000,
  });
  try {
    const result = await runStartupLegacyContactImport({
      client: database,
      manifestPath: resolve('data/texas/legacy-contacts/legacy-contact-manifest.json'),
      requestedArtifactId,
      onProgress: (progress) =>
        process.stdout.write(
          `${JSON.stringify({ event: 'legacy_contact_import_progress', ...progress })}\n`,
        ),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.close();
  }
}
