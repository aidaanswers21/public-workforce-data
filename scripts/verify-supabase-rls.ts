import { TABLE_NAMES } from '../packages/database/src/schema.js';

const baseUrl = requiredEnvironment('SUPABASE_TEST_URL').replace(/\/$/, '');
const publishableKey = requiredEnvironment('SUPABASE_TEST_PUBLISHABLE_KEY');
const failures: string[] = [];
let denied = 0;
let empty = 0;

for (const table of TABLE_NAMES.filter((name) => name !== 'schema_migrations')) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` },
  });
  const body = await response.text();
  if ([401, 403, 404].includes(response.status)) denied += 1;
  else if (response.ok && body.trim() === '[]') empty += 1;
  else failures.push(`${table}: HTTP ${response.status} ${body.slice(0, 160)}`);
}

process.stdout.write(
  `${JSON.stringify({ tested: denied + empty + failures.length, denied, empty, failures })}\n`,
);
if (failures.length > 0) process.exitCode = 1;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}
