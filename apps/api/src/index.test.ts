import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from '@public-workforce/database';
import { createApi } from './index.js';

let database: TestDatabase | undefined;
let server: ReturnType<typeof createApi> | undefined;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (server === undefined || !server.listening) return resolve();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await database?.close();
  database = undefined;
  server = undefined;
});

async function start(authenticated: boolean): Promise<string> {
  database = await TestDatabase.create();
  server = createApi({
    client: database,
    authenticate: () => (authenticated ? { subject: 'api-test' } : null),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('API did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('read API controls', () => {
  it('leaves health public but refuses an unauthenticated data request', async () => {
    const base = await start(false);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const response = await fetch(`${base}/coverage`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses an authenticated request with an unregistered purpose', async () => {
    const base = await start(true);
    const response = await fetch(`${base}/records?purpose=made-up`);
    expect(response.status).toBe(403);
  });

  it('accepts a purpose only after a named approval is recorded', async () => {
    const base = await start(true);
    await database?.query(
      `insert into export_purposes (
         code, description, owner, approved_by, approved_at
       ) values ('internal-review','Review collected evidence','data-owner','human-owner',$1)`,
      ['2026-09-04T00:00:00.000Z'],
    );
    const response = await fetch(`${base}/records?purpose=internal-review`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ purpose: 'internal-review', count: 0 });
  });
});
