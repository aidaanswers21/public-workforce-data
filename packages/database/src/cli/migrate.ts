#!/usr/bin/env node
import { createLogger } from '@public-workforce/observability';
import { PostgresClient } from '../pg.js';
import { checkMigrations, loadMigrations, migrate, rollback } from '../migrations.js';

/**
 * Migration CLI.
 *
 * `pnpm db:migrate` applies pending migrations; `--rollback <version>` reverts
 * down to and including a version; `--check` validates the files without
 * touching a database, which is what CI runs.
 */
async function main(): Promise<void> {
  const logger = createLogger({ name: 'db-migrate' });
  const args = process.argv.slice(2);
  const migrations = loadMigrations();

  if (args.includes('--check')) {
    const issues = checkMigrations(migrations);
    for (const issue of issues) logger.error({ issue }, 'migration issue');
    logger.info({ count: migrations.length, issues: issues.length }, 'migration check complete');
    process.exitCode = issues.length === 0 ? 0 : 1;
    return;
  }

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.error('DATABASE_URL is not set; see .env.example');
    process.exitCode = 1;
    return;
  }

  const client = new PostgresClient({ connectionString });
  try {
    const rollbackIndex = args.indexOf('--rollback');
    if (rollbackIndex !== -1) {
      const target = args[rollbackIndex + 1];
      const reverted = await rollback(client, migrations, target);
      logger.info({ reverted }, 'rollback complete');
      return;
    }
    const result = await migrate(client, migrations);
    logger.info({ applied: result.applied, skipped: result.skipped.length }, 'migrations applied');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
