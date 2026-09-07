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
const nationalTemplate = {
  ...template,
  key: 'fixture-national-scope',
  name: 'Fixture national scope',
  governmentLevelCode: 'county',
  jurisdictionCode: 'fixture-national-scope',
  stateCode: null,
};
const projectBuilderCatalog = {
  governmentLevels: [
    { code: 'state', name: 'State', description: 'State or territorial government.' },
    { code: 'county', name: 'County', description: 'County or equivalent government.' },
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
  explorerPresets: [
    {
      key: 'fixture-organizations',
      name: 'Fixture organizations',
      singularName: 'Fixture organization',
      description: 'Official fixture organization records and published attributes.',
      organizationTypeCodes: ['state_department'],
      sectorCodes: ['general_government'],
      attributeColumns: [
        { key: 'populationServed', label: 'Population served', format: 'integer' as const },
      ],
    },
  ],
  states: [
    { code: 'CO', name: 'Colorado', description: 'State location filter.' },
    { code: 'TX', name: 'Texas', description: 'State location filter.' },
  ],
};
const organizationSpineInventory = {
  generatedAt: '2026-09-07T18:31:42.955Z',
  sourceRows: 231_016,
  geographicAreas: 85_415,
  relationships: 107_981,
  publishedWebsiteValues: 138_205,
  missingWebsiteQueue: 90_003,
  exactWebsiteOverlays: 394,
  classificationWork: 167_561,
  reconciliationRequired: 472,
  sources: [
    {
      key: 'fixture-national-directory',
      name: 'Fixture national directory',
      catalogUrl: 'https://example.test/catalog',
      records: 231_016,
      publishedWebsites: 138_205,
      missingWebsites: 92_811,
    },
  ],
  geographies: [{ code: 'state', name: 'States', records: 52 }],
  states: [
    { code: 'CO', name: 'Colorado' },
    { code: 'TX', name: 'Texas' },
  ],
  notes: ['Fixture source rows remain separate until exact identifiers match.'],
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

  it('shows staged inventory separately from hosted records and exposes queue filters', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const page = await fetch(`${origin}/spine?stateCode=TX`, { headers: { cookie } });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('Organization spine');
    expect(html).toContain('231,016');
    expect(html).toContain('Staged is not loaded');
    expect(html).toContain('Hosted database staging');
    expect(html).toContain('Not loaded');
    expect(html).toContain('Fixture national directory');
    expect(html).toContain('name="governmentLevelCode"');
    expect(html).toContain('name="sectorCode"');
    expect(html).toContain('name="stateCode"');
    expect(html).toContain('<option value="TX" selected>Texas</option>');
    expect(html).toContain('name="organizationTypeCode"');
    expect(html).toContain('have not been imported into this database yet');
  });

  it('browses source-record profiles and adds bulk selections without releasing work', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const database = databases[0];
    const source = await database?.query<{ id: string }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code
       ) values (
         'https://example.test/release', 'https://example.test/release',
         'admin-explorer-release', 'example.test', 'bulk_dataset'
       ) returning id`,
    );
    const version = await database?.query<{ id: string }>(
      `insert into source_document_versions (
         source_document_id, version, content_hash, http_status, content_type
       ) values ($1,1,'admin-explorer-content',200,'application/json') returning id`,
      [source?.rows[0]?.id],
    );
    const record = await database?.query<{ id: string }>(
      `insert into organization_spine_records (
         source_key, source_record_key, name, name_normalized,
         organization_type_code, sector_code, classification_review_reason,
         website_url, identifiers, location, attributes, status,
         source_document_id, source_document_version_id, source_effective_date
       ) values (
         'fixture-release','official-001','Fixture Public Body','fixture public body',
         'state_department','general_government','Level requires authoritative review.',
         'https://body.example.test','[{"systemCode":"fixture_id","value":"official-001"}]',
         '{"addressLine1":"100 Public Way","city":"Example","stateCode":"TX","postalCode":"70000"}',
         '{"populationServed":12345}','classification_hold',$1,$2,'2026-09-01'
       ) returning id`,
      [source?.rows[0]?.id, version?.rows[0]?.id],
    );

    const list = await fetch(`${origin}/organization-records?preset=fixture-organizations`, {
      headers: { cookie },
    });
    const listHtml = await list.text();
    expect(list.status).toBe(200);
    expect(listHtml).toContain('Fixture organizations explorer');
    expect(listHtml).toContain('12,345');
    expect(listHtml).toContain('Awaiting classification');
    expect(listHtml).toContain(`/organization-records/${record?.rows[0]?.id}`);

    const profile = await fetch(`${origin}/organization-records/${record?.rows[0]?.id}`, {
      headers: { cookie },
    });
    const profileHtml = await profile.text();
    expect(profile.status).toBe(200);
    expect(profileHtml).toContain('100 Public Way');
    expect(profileHtml).toContain('Where this came from');

    const projectCreated = await fetch(`${origin}/projects`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        template: 'fixture-scope',
        stateCode: 'TX',
        governmentLevelCode: 'state',
        sectorCode: 'general_government',
        name: 'Source record selection',
        batchSize: '5',
        maxPagesPerTarget: '5',
        maxPagesPerBatch: '20',
        maxErrorsPerBatch: '2',
      }),
    });
    const projectId = projectCreated.headers.get('location')?.split('/')[2]?.split('?')[0] ?? '';
    const selected = await fetch(`${origin}/organization-records/projects`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        projectId,
        recordIds: record?.rows[0]?.id ?? '',
        preset: 'fixture-organizations',
      }),
    });
    expect(selected.status).toBe(303);
    expect(decodeURIComponent(selected.headers.get('location') ?? '')).toContain(
      '1 awaiting classification',
    );
    expect(await database?.count('collection_project_source_records')).toBe(1);
    expect(await database?.count('collection_batches')).toBe(0);
    expect(await database?.count('collection_jobs')).toBe(0);
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

  it('creates a state-filtered project from a national source configuration', async () => {
    const { origin } = await start();
    const cookie = await login(origin);
    const response = await fetch(`${origin}/projects`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        template: 'fixture-national-scope',
        stateCode: 'CO',
        governmentLevelCode: 'county',
        sectorCode: 'general_government',
        name: 'Colorado county collection',
        workMode: 'approved_batch_complete',
        batchSize: '100',
        maxPagesPerTarget: '10',
        maxPagesPerBatch: '1000',
        maxErrorsPerBatch: '10',
      }),
    });

    expect(response.status).toBe(303);
    const project = await databases[0]?.query<{ state_code: string }>(
      'select state_code from collection_projects where name = $1',
      ['Colorado county collection'],
    );
    expect(project?.rows[0]?.state_code).toBe('CO');
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
    projectTemplates: [template, nationalTemplate],
    projectBuilderCatalog,
    organizationSpineInventory,
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
