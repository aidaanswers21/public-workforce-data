#!/usr/bin/env node
import { createLogger } from '@public-workforce/observability';
import { PostgresClient } from '@public-workforce/database';
import { AdminReports } from './reports.js';

const USAGE = `
pan-admin: inspect crawl runs, coverage and data quality.

  runs [limit]              recent collection runs and their statistics
  failures [runId]          errors grouped by kind
  coverage [level] [sector] organization, record and email counts
  organizations             organization counts by government level and type
  policies [limit]          sources awaiting a human policy review
  sample [limit]            lowest-confidence records, for eyeballing
  titles [limit]            published titles the taxonomy does not recognize

Requires DATABASE_URL. See .env.example.
`;

async function main(): Promise<void> {
  const logger = createLogger({ name: 'pan-admin' });
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.error('DATABASE_URL is not set; see .env.example');
    process.exitCode = 1;
    return;
  }

  const client = new PostgresClient({ connectionString });
  const reports = new AdminReports(client);

  try {
    switch (command) {
      case 'runs':
        print(await reports.recentRuns(numberArg(args[0], 20)));
        break;
      case 'failures':
        print(await reports.failureBreakdown(args[0]));
        break;
      case 'coverage':
        print(
          await reports.coverage({
            ...(args[0] === undefined ? {} : { governmentLevelCode: args[0] }),
            ...(args[1] === undefined ? {} : { sectorCode: args[1] }),
          }),
        );
        break;
      case 'organizations':
        print(await reports.organizationBreakdown());
        break;
      case 'policies':
        print(await reports.sourcePolicyQueue(numberArg(args[0], 25)));
        break;
      case 'sample':
        print(await reports.dataQualitySample(numberArg(args[0], 10)));
        break;
      case 'titles':
        print(await reports.unmatchedTitles(numberArg(args[0], 25)));
        break;
      default:
        process.stdout.write(`unknown command "${command}"\n${USAGE}\n`);
        process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function numberArg(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
