import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from '@public-workforce/database';
import { createAdminServer, hashAdminPassword, type AdminServerOptions } from './server.js';

const servers: Server[] = [];
const databases: TestDatabase[] = [];
const template = {
  key: 'fixture-scope',
  name: 'Fixture scope',
  governmentLevelCode: 'state',
  sectorCodes: ['general_government'],
  jurisdictionCode: 'fixture-scope',
  stateCode: 'TX',
  officialSources: [
    {
      key: 'fixture-source',
      name: 'Fixture source',
      url: 'https://example.test/source',
      provides: 'Fixture organizations',
      verified: false,
      verificationNote: 'Confirm before use.',
    },
  ],
  notes: [],
};
const projectBuilderCatalog = {
  governmentLevels: [
    { code: 'state', name: 'State', description: 'State or territorial government.' },
  ],
  sectors: [
    {
      code: 'general_government',
      name: 'General government',
      description: 'Executive and administrative services.',
    },
  ],
  organizationTypes: [
    {
      code: 'state_department',
      name: 'State department',
      description: 'A cabinet-level department.',
      defaultGovernmentLevelCode: 'state',
      defaultSectorCode: 'general_government',
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('local admin server', () => {
  it('requires a login before showing the console', async () => {
    const { origin } = await start();
    const response = await fetch(origin, { redirect: 'manual' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('rejects an incorrect password without creating a session', async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'operator@example.test', password: 'wrong' }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('did not match');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('creates a private session and renders the empty dashboard', async () => {
    const { origin } = await start();
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'operator@example.test',
        password: 'local-password',
      }),
    });

    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const dashboard = await fetch(origin, {
      headers: { cookie: cookie?.split(';')[0] ?? '' },
    });
    const html = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(html).toContain('Operator console');
    expect(html).toContain('No records have been collected yet');
    expect(dashboard.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('creates and displays a draft collection project without starting work', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const created = await fetch(`${origin}/projects`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        template: 'fixture-scope',
        stateCode: 'TX',
        governmentLevelCode: 'state',
        sectorCode: 'general_government',
        name: 'My first collection',
        workMode: 'approved_batch_complete',
        batchSize: '5',
        maxPagesPerTarget: '5',
        maxPagesPerBatch: '20',
        maxErrorsPerBatch: '2',
      }),
    });

    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toMatch(/^\/projects\/[0-9a-f-]+/);
    const detail = await fetch(`${origin}${created.headers.get('location') ?? ''}`, {
      headers: { cookie },
    });
    const html = await detail.text();
    expect(html).toContain('My first collection');
    expect(html).toContain('No work has been released');
    expect(html).toContain('Unverified');
    expect(html).toContain('Continue until approved batch is complete');
    expect(await databases[0]?.count('collection_batches')).toBe(0);
  });

  it('renders taxonomy-backed scope controls and the drag selection asset', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const page = await fetch(`${origin}/projects/new`, { headers: { cookie } });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('Configured jurisdiction');
    expect(html).toContain('Government level');
    expect(html).toContain('name="stateCode"');
    expect(html).toContain('name="governmentLevelCode"');
    expect(html).toContain('name="sectorCode"');
    expect(html).toContain('State department');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('A batch of 100 targets may yield thousands');
    expect(html).toContain('Continue until the approved batch is complete');

    const asset = await fetch(`${origin}/assets/project-builder.js`, { headers: { cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toContain("addEventListener('drop'");
  });

  it('rejects a scope combination without a matching reviewed configuration', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const response = await fetch(`${origin}/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        template: 'fixture-scope',
        stateCode: 'National',
        governmentLevelCode: 'federal',
        sectorCode: 'general_government',
        name: 'Unsupported scope',
        batchSize: '100',
        maxPagesPerTarget: '10',
        maxPagesPerBatch: '1000',
        maxErrorsPerBatch: '10',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('need a matching reviewed jurisdiction configuration');
  });

  it('records and separately approves a reviewed source policy', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const reviewed = await fetch(`${origin}/policies`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        domain: 'example.test',
        sourceTypeCode: 'html_directory',
        collectionStatus: 'review_required',
        automatedAccessStatus: 'permitted',
        commercialUseStatus: 'unknown',
        solicitationStatus: 'restricted',
        policyUrl: 'https://example.test/terms',
        policyTextSnapshot: 'Automated access is permitted with limits.',
        reviewNotes: 'Reviewed the saved terms and robots policy.',
      }),
    });
    expect(reviewed.status).toBe(303);

    const policy = await databases[0]?.query<{ id: string }>('select id from source_policies');
    const id = policy?.rows[0]?.id ?? '';
    const approved = await fetch(`${origin}/policies/${id}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        approvalConfirmed: 'yes',
        approvalNote: 'Approve this reviewed fixture source.',
      }),
    });
    expect(approved.status).toBe(303);

    const page = await fetch(`${origin}/policies`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('example.test');
    expect(html).toContain('operator@example.test');
    expect(html).toContain('Source policies');
  });

  it('uses a hashed password and secure cookie in hosted mode', async () => {
    const publicOrigin = 'https://console.example.test';
    const { origin } = await start({
      password: undefined,
      passwordHash: hashAdminPassword('hosted-password', 'fixed-test-salt'),
      hosted: true,
      publicOrigin,
    });
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        origin: publicOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: 'operator@example.test',
        password: 'hosted-password',
      }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain('__Host-public_workforce_admin=');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  it('blocks cross-origin hosted form submissions', async () => {
    const { origin } = await start({
      hosted: true,
      publicOrigin: 'https://console.example.test',
      password: undefined,
      passwordHash: hashAdminPassword('hosted-password', 'cross-origin-test-salt'),
    });
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: 'operator@example.test',
        password: 'local-password',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Request blocked');
  });

  it('accepts a direct hosted form submission when the browser omits Origin', async () => {
    const publicOrigin = 'https://console.example.test';
    const { origin } = await start({
      hosted: true,
      publicOrigin,
      password: undefined,
      passwordHash: hashAdminPassword('hosted-password', 'originless-test-salt'),
    });
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'x-forwarded-host': 'console.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: 'operator@example.test',
        password: 'hosted-password',
      }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain('__Host-public_workforce_admin=');
  });

  it('throttles repeated login failures', async () => {
    const { origin } = await start();
    const attempt = () =>
      fetch(`${origin}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: 'operator@example.test',
          password: 'wrong',
        }),
      });

    for (let count = 0; count < 5; count += 1) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('900');
  });

  it('reports database readiness through the health endpoint', async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ready' });
  });
});

async function start(
  overrides: Partial<
    Pick<AdminServerOptions, 'password' | 'passwordHash' | 'hosted' | 'publicOrigin'>
  > = {},
): Promise<{ origin: string }> {
  const database = await TestDatabase.create();
  databases.push(database);
  const server = createAdminServer({
    database,
    email: 'operator@example.test',
    password: 'local-password',
    sessionSecret: 'test-secret-with-enough-entropy-for-the-test-suite',
    projectTemplates: [template],
    projectBuilderCatalog,
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: 'operator@example.test',
      password: 'local-password',
    }),
  });
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}
