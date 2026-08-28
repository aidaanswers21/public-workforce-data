#!/usr/bin/env node
import { createLogger } from '@pan/observability';
import { PostgresClient } from '@pan/database';
import { AdminReports } from './reports.js';

const USAGE = `
pan-admin: inspect crawl runs, coverage and data quality.

  runs [limit]            recent crawl runs and their statistics
  failures [runId]        crawl errors grouped by kind
  coverage <STATE>        institution, record and email counts for a state
  sample <STATE> [limit]  lowest-confidence records, for eyeballing
  titles <STATE> [limit]  published titles the rule table does not recognize

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
        print(await reports.coverage(requireArg(args[0], 'STATE')));
        break;
      case 'sample':
        print(
          await reports.dataQualitySample(requireArg(args[0], 'STATE'), numberArg(args[1], 10)),
        );
        break;
      case 'titles':
        print(await reports.unmatchedTitles(requireArg(args[0], 'STATE'), numberArg(args[1], 25)));
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

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing required argument <${name}>`);
  return value;
}

function numberArg(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
