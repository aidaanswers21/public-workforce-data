#!/usr/bin/env node
import { createHash, createHmac, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PGliteClient,
  PostgresClient,
  CollectionProjectRepository,
  ExportPurposeRepository,
  ExportRepository,
  OrganizationRecordRepository,
  SourcePolicyRepository,
  WebsiteResolutionRepository,
  type CollectionBatchSummary,
  type CollectionPolicyHold,
  type CollectionProjectSummary,
  type MissingWebsiteOrganization,
  type OrganizationRecordPage,
  type OrganizationSourceRecord,
  loadMigrations,
  migrate,
  type CoverageSummary,
  type ExportPurpose,
  type SqlClient,
} from '@public-workforce/database';
import { createLogger } from '@public-workforce/observability';
import type { SourcePolicyRecord } from '@public-workforce/shared-types';
import {
  buildJurisdictionRegistry,
  buildOrganizationSpineInventory,
  buildTaxonomy,
} from '@public-workforce/crawler-worker';
import {
  AdminReports,
  type DataQualitySample,
  type OrganizationSpineSummary,
  type RunSummaryRow,
} from './reports.js';

const COOKIE_NAME = 'public_workforce_admin';
const HOSTED_COOKIE_NAME = '__Host-public_workforce_admin';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const DEFAULT_DATABASE_PATH = 'storage/local-admin-db';
const EMPTY_PROJECT_BUILDER_CATALOG: ProjectBuilderCatalog = {
  governmentLevels: [],
  sectors: [],
  organizationTypes: [],
  explorerPresets: [],
};

export interface AdminServerOptions {
  database: SqlClient;
  email: string;
  password?: string;
  passwordHash?: string;
  sessionSecret: string;
  hosted?: boolean;
  publicOrigin?: string;
  now?: () => Date;
  projectTemplates?: readonly CollectionProjectTemplate[];
  projectBuilderCatalog?: ProjectBuilderCatalog;
  organizationSpineInventory?: OrganizationSpineInventory;
}

export interface OrganizationSpineInventory {
  generatedAt: string;
  sourceRows: number;
  geographicAreas: number;
  relationships: number;
  publishedWebsiteValues: number;
  missingWebsiteQueue: number;
  exactWebsiteOverlays: number;
  classificationWork: number;
  reconciliationRequired: number;
  sources: readonly {
    key: string;
    name: string;
    catalogUrl: string;
    records: number;
    publishedWebsites: number;
    missingWebsites: number;
  }[];
  geographies: readonly { code: string; name: string; records: number }[];
  states: readonly { code: string; name: string }[];
  notes: readonly string[];
}

export interface ProjectBuilderOption {
  code: string;
  name: string;
  description: string;
}

export interface ProjectBuilderOrganizationType extends ProjectBuilderOption {
  defaultGovernmentLevelCode: string | null;
  defaultSectorCode: string | null;
}

export interface ProjectBuilderCatalog {
  governmentLevels: readonly ProjectBuilderOption[];
  sectors: readonly ProjectBuilderOption[];
  organizationTypes: readonly ProjectBuilderOrganizationType[];
  states?: readonly ProjectBuilderOption[];
  explorerPresets: readonly OrganizationExplorerPreset[];
}

export interface OrganizationExplorerPreset {
  key: string;
  name: string;
  singularName: string;
  description: string;
  organizationTypeCodes: readonly string[];
  sectorCodes: readonly string[];
  sourceKeys: readonly string[];
  attributeColumns: readonly {
    key: string;
    label: string;
    format: 'integer' | 'decimal' | 'text';
  }[];
}

export interface CollectionProjectTemplate {
  key: string;
  name: string;
  governmentLevelCode: string;
  sectorCodes: readonly string[];
  jurisdictionCode: string;
  stateCode: string | null;
  officialSources: readonly {
    key: string;
    name: string;
    url: string;
    provides: string;
    verified: boolean;
    verificationNote: string;
  }[];
  notes: readonly string[];
  defaultMaxPagesPerTarget?: number;
}

interface DashboardData {
  coverage: CoverageSummary;
  records: DataQualitySample[];
  runs: RunSummaryRow[];
  organizations: Awaited<ReturnType<AdminReports['organizationBreakdown']>>;
}

interface SpineFilters {
  governmentLevelCode: string;
  sectorCode: string;
  stateCode: string;
  organizationTypeCode: string;
}

export function createAdminServer(options: AdminServerOptions): Server {
  const reports = new AdminReports(options.database);
  const projects = new CollectionProjectRepository(options.database);
  const organizationRecords = new OrganizationRecordRepository(options.database);
  const sourcePolicies = new SourcePolicyRepository(options.database);
  const exportPurposes = new ExportPurposeRepository(options.database);
  const exports = new ExportRepository(options.database);
  const websites = new WebsiteResolutionRepository(options.database);
  const projectTemplates = options.projectTemplates ?? [];
  const projectBuilderCatalog = options.projectBuilderCatalog ?? EMPTY_PROJECT_BUILDER_CATALOG;
  const organizationSpineInventory = options.organizationSpineInventory;
  const now = options.now ?? (() => new Date());
  const hosted = options.hosted ?? false;
  if (
    hosted &&
    (options.password !== undefined ||
      options.passwordHash === undefined ||
      options.publicOrigin === undefined ||
      !options.publicOrigin.startsWith('https://') ||
      options.sessionSecret.length < 32)
  ) {
    throw new Error(
      'Hosted admin requires a password hash, HTTPS public origin, and a strong session secret.',
    );
  }
  const cookieName = hosted ? HOSTED_COOKIE_NAME : COOKIE_NAME;
  const failedLogins = new Map<string, { failures: number; blockedUntil: number }>();

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    setSecurityHeaders(response, hosted);
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (
        request.method === 'POST' &&
        options.publicOrigin !== undefined &&
        !isTrustedMutationRequest(request, options.publicOrigin)
      ) {
        console.error(
          JSON.stringify({
            event: 'admin_origin_rejected',
            origin: request.headers.origin ?? null,
            host: request.headers['x-forwarded-host'] ?? request.headers.host ?? null,
            fetchSite: request.headers['sec-fetch-site'] ?? null,
          }),
        );
        sendHtml(
          response,
          403,
          renderMessage('Request blocked', 'Use the hosted console directly.'),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        try {
          await options.database.query('select 1 as ok');
          sendJson(response, 200, { status: 'ok', database: 'ready' });
        } catch (error) {
          console.error(
            JSON.stringify({ event: 'admin_health_failed', message: errorMessage(error) }),
          );
          sendJson(response, 503, { status: 'unavailable', database: 'unavailable' });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/login') {
        if (isAuthenticated(request, cookieName, options.sessionSecret, now())) {
          redirect(response, '/');
          return;
        }
        sendHtml(response, 200, renderLogin(hosted));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await readBody(request));
        const email = form.get('email') ?? '';
        const password = form.get('password') ?? '';
        const loginKey = clientLoginKey(request);
        const loginState = failedLogins.get(loginKey);
        if (loginState !== undefined && loginState.blockedUntil > now().getTime()) {
          response.setHeader(
            'Retry-After',
            String(Math.ceil((loginState.blockedUntil - now().getTime()) / 1000)),
          );
          sendHtml(response, 429, renderLogin(hosted, 'Too many attempts. Try again later.'));
          return;
        }
        const emailMatches = secureEqual(email, options.email);
        const passwordMatches = verifyAdminPassword(
          password,
          options.password,
          options.passwordHash,
        );
        if (!emailMatches || !passwordMatches) {
          const failures = (loginState?.failures ?? 0) + 1;
          failedLogins.set(loginKey, {
            failures,
            blockedUntil: failures >= LOGIN_FAILURE_LIMIT ? now().getTime() + LOGIN_WINDOW_MS : 0,
          });
          sendHtml(response, 401, renderLogin(hosted, 'That email or password did not match.'));
          return;
        }
        failedLogins.delete(loginKey);

        const expiresAt = now().getTime() + SESSION_LIFETIME_MS;
        const token = createSessionToken(email, expiresAt, options.sessionSecret);
        response.setHeader(
          'Set-Cookie',
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
            SESSION_LIFETIME_MS / 1000,
          )}${hosted ? '; Secure' : ''}`,
        );
        redirect(response, '/');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/logout') {
        response.setHeader(
          'Set-Cookie',
          `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${hosted ? '; Secure' : ''}`,
        );
        redirect(response, '/login');
        return;
      }

      const authenticatedEmail = authenticatedUser(
        request,
        cookieName,
        options.sessionSecret,
        now(),
      );
      if (authenticatedEmail === null) {
        redirect(response, '/login');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        const [coverage, records, runs, organizations] = await Promise.all([
          reports.coverage(),
          reports.dataQualitySample(100),
          reports.recentRuns(8),
          reports.organizationBreakdown(),
        ]);
        const query = (url.searchParams.get('q') ?? '').trim();
        const visibleRecords = filterRecords(records, query);
        sendHtml(
          response,
          200,
          renderDashboard(
            { coverage, records: visibleRecords, runs, organizations },
            query,
            hosted,
          ),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/projects') {
        sendHtml(response, 200, renderProjects(await projects.list(), projectTemplates, hosted));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/exports') {
        const [purposes, collectionProjects] = await Promise.all([
          exportPurposes.listActive(),
          projects.list(),
        ]);
        sendHtml(
          response,
          200,
          renderExports(
            purposes,
            collectionProjects,
            url.searchParams.get('message') ?? '',
            hosted,
            url.searchParams.get('projectId') ?? '',
          ),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/export-purposes') {
        const form = new URLSearchParams(await readBody(request));
        try {
          if (form.get('approvalConfirmed') !== 'yes') {
            throw new Error('confirm this exact export purpose approval');
          }
          await exportPurposes.approve({
            code: form.get('code') ?? '',
            description: form.get('description') ?? '',
            owner: authenticatedEmail,
            approvedBy: authenticatedEmail,
          });
          redirect(response, '/exports?message=Export+purpose+approved');
        } catch (error) {
          if (response.headersSent)
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          else redirect(response, `/exports?message=${encodeURIComponent(errorMessage(error))}`);
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/exports/download') {
        const form = new URLSearchParams(await readBody(request));
        if (form.get('exportConfirmed') !== 'yes') {
          redirect(response, '/exports?message=Confirm+this+exact+export');
          return;
        }
        const projectId = form.get('projectId') ?? '';
        const project = await projects.get(projectId);
        if (project === null) {
          redirect(response, '/exports?message=Choose+a+collection+project');
          return;
        }
        const purpose = form.get('purpose') ?? '';
        const limit = formInteger(form, 'limit', 50_000);
        if (limit < 1 || limit > 50_000) {
          redirect(response, '/exports?message=Export+limit+must+be+between+1+and+50000');
          return;
        }
        try {
          if (form.get('downloadAll') === 'yes') {
            let started = false;
            await exports.streamPeopleExport(
              {
                name: `${project.name} ${now().toISOString()}`,
                requestedBy: authenticatedEmail,
                purpose,
                filters: {
                  collectionProjectId: projectId,
                  includeGeneralInboxes: form.get('includeGeneralInboxes') === 'yes',
                },
              },
              async (chunk) => {
                if (response.destroyed) throw new Error('download disconnected');
                if (!started) {
                  response.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${slug(project.name)}-all.csv"`,
                    'Cache-Control': 'no-store',
                  });
                  started = true;
                }
                if (!response.write(chunk)) {
                  await new Promise<void>((resolve, reject) => {
                    const cleanup = () => {
                      response.off('drain', drained);
                      response.off('close', closed);
                      response.off('error', failed);
                    };
                    const drained = () => {
                      cleanup();
                      resolve();
                    };
                    const failed = (error: Error) => {
                      cleanup();
                      reject(error);
                    };
                    const closed = () => failed(new Error('download disconnected'));
                    response.once('drain', drained);
                    response.once('close', closed);
                    response.once('error', failed);
                    if (response.destroyed) closed();
                  });
                }
              },
            );
            response.end();
            return;
          }
          const built = await exports.buildPeopleExport({
            name: `${project.name} ${now().toISOString()}`,
            requestedBy: authenticatedEmail,
            purpose,
            filters: {
              collectionProjectId: projectId,
              includeGeneralInboxes: form.get('includeGeneralInboxes') === 'yes',
              limit,
            },
          });
          sendCsv(
            response,
            built.csv,
            `${slug(project.name)}-${now().toISOString().slice(0, 10)}.csv`,
            built.exportId,
          );
        } catch (error) {
          if (response.headersSent)
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          else redirect(response, `/exports?message=${encodeURIComponent(errorMessage(error))}`);
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/organization-records') {
        const preset = explorerPreset(url.searchParams.get('preset'), projectBuilderCatalog);
        if (preset === null) {
          sendHtml(
            response,
            200,
            renderMessage(
              'No organization explorer is configured',
              'Register an explorer preset in a sector pack to browse its official source records.',
            ),
          );
          return;
        }
        const stateCode = knownStateCode(url.searchParams.get('stateCode'), projectBuilderCatalog);
        const websiteAvailability = websiteFilter(url.searchParams.get('website'));
        const pageNumber = positiveInteger(url.searchParams.get('page'), 1);
        const pageSize = 100;
        const [recordPage, projectRows] = await Promise.all([
          organizationRecords.list({
            organizationTypeCodes: preset.organizationTypeCodes,
            sectorCodes: preset.sectorCodes,
            sourceKeys: preset.sourceKeys,
            stateCode,
            query: url.searchParams.get('q') ?? '',
            websiteAvailability,
            limit: pageSize,
            offset: (pageNumber - 1) * pageSize,
          }),
          projects.list(),
        ]);
        sendHtml(
          response,
          200,
          renderOrganizationRecords(
            preset,
            recordPage,
            projectRows,
            projectBuilderCatalog,
            {
              query: url.searchParams.get('q') ?? '',
              stateCode: stateCode ?? '',
              websiteAvailability,
              page: pageNumber,
              message: url.searchParams.get('message') ?? '',
            },
            hosted,
          ),
        );
        return;
      }

      const organizationRecordMatch = /^\/organization-records\/([0-9a-f-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && organizationRecordMatch !== null) {
        const record = await organizationRecords.get(organizationRecordMatch[1] as string);
        if (record === null) {
          sendHtml(
            response,
            404,
            renderMessage('Organization record not found', 'Return to the organization explorer.'),
          );
          return;
        }
        const preset = matchingExplorerPreset(record, projectBuilderCatalog);
        sendHtml(
          response,
          200,
          renderOrganizationRecordProfile(
            record,
            preset,
            await projects.list(),
            url.searchParams.get('message') ?? '',
            hosted,
          ),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/organization-records/projects') {
        const form = new URLSearchParams(await readBody(request));
        const presetKey = form.get('preset') ?? '';
        const returnPath = safeExplorerReturnPath(form.get('returnTo'), presetKey);
        try {
          const result = await organizationRecords.addToProject(
            form.get('projectId') ?? '',
            form.getAll('recordIds'),
            authenticatedEmail,
          );
          const message = `${result.selected} selected; ${result.crawlReady} collection-ready; ${result.held} awaiting classification`;
          redirect(
            response,
            `${returnPath}${returnPath.includes('?') ? '&' : '?'}message=${encodeURIComponent(message)}`,
          );
        } catch (error) {
          redirect(
            response,
            `${returnPath}${returnPath.includes('?') ? '&' : '?'}message=${encodeURIComponent(errorMessage(error))}`,
          );
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/spine') {
        const filters = spineFilters(url, projectBuilderCatalog, organizationSpineInventory);
        const [summary, queue] = await Promise.all([
          reports.organizationSpineSummary(),
          websites.missingWebsiteQueue({
            limit: 100,
            governmentLevelCodes: selected(filters.governmentLevelCode),
            sectorCodes: selected(filters.sectorCode),
            stateCodes: selected(filters.stateCode),
            organizationTypeCodes: selected(filters.organizationTypeCode),
          }),
        ]);
        sendHtml(
          response,
          200,
          renderOrganizationSpine(
            summary,
            queue,
            organizationSpineInventory,
            projectBuilderCatalog,
            filters,
            hosted,
          ),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/policies') {
        const returnTo = policyReturnPath(url.searchParams.get('returnTo'));
        sendHtml(
          response,
          200,
          renderSourcePolicies(
            await sourcePolicies.list(),
            url.searchParams.get('message') ?? '',
            {
              domain: url.searchParams.get('domain') ?? '',
              sourceTypeCode: url.searchParams.get('sourceTypeCode') ?? '',
              returnTo,
            },
            hosted,
          ),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/policies') {
        const form = new URLSearchParams(await readBody(request));
        const returnTo = policyReturnPath(form.get('returnTo'));
        try {
          await sourcePolicies.recordReview({
            domain: form.get('domain'),
            urlPattern: form.get('urlPattern'),
            sourceTypeCode: form.get('sourceTypeCode'),
            collectionStatus: policyValue(form, 'collectionStatus'),
            commercialUseStatus: stanceValue(form, 'commercialUseStatus'),
            solicitationStatus: stanceValue(form, 'solicitationStatus'),
            automatedAccessStatus: stanceValue(form, 'automatedAccessStatus'),
            policyUrl: form.get('policyUrl'),
            policyTextSnapshot: form.get('policyTextSnapshot'),
            reviewNotes: form.get('reviewNotes') ?? '',
            reviewedBy: authenticatedEmail,
          });
          redirect(
            response,
            `/policies?message=Source+review+recorded&returnTo=${encodeURIComponent(returnTo)}`,
          );
        } catch (error) {
          redirect(
            response,
            `/policies?message=${encodeURIComponent(errorMessage(error))}&returnTo=${encodeURIComponent(returnTo)}`,
          );
        }
        return;
      }

      const policyApproval = /^\/policies\/([0-9a-f-]+)\/approve$/.exec(url.pathname);
      if (request.method === 'POST' && policyApproval !== null) {
        const form = new URLSearchParams(await readBody(request));
        const returnTo = policyReturnPath(form.get('returnTo'));
        try {
          if (form.get('approvalConfirmed') !== 'yes') {
            throw new Error('confirm this exact production source approval');
          }
          await sourcePolicies.approve(
            policyApproval[1] as string,
            authenticatedEmail,
            form.get('approvalNote') ?? '',
          );
          redirect(
            response,
            `/policies?message=Production+approval+recorded&returnTo=${encodeURIComponent(returnTo)}`,
          );
        } catch (error) {
          redirect(
            response,
            `/policies?message=${encodeURIComponent(errorMessage(error))}&returnTo=${encodeURIComponent(returnTo)}`,
          );
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/collections/new') {
        sendHtml(
          response,
          200,
          page(
            'Collect by state',
            `${appHeader('/projects', hosted)}<main class="dashboard narrow-dashboard">
          <h1>Collect by state</h1><p>Choose the official organization rosters and states. Preparation uses the loaded source releases and makes no website requests.</p>
          <form class="panel panel-body release-form" method="post" action="/collections">
          <label>Collection name<input name="name" required></label>
          <fieldset><legend>Organization rosters</legend>${projectBuilderCatalog.explorerPresets.map((preset) => `<label class="check-label"><input type="checkbox" name="presets" value="${escapeAttribute(preset.key)}" checked><span>${escapeHtml(preset.name)}</span></label>`).join('')}</fieldset>
          <label>States<select name="states" multiple required size="10">${(projectBuilderCatalog.states ?? []).map((state) => `<option value="${escapeAttribute(state.code)}">${escapeHtml(state.name)}</option>`).join('')}</select></label>
          <label>Requests per target<input type="number" name="maxPagesPerTarget" min="1" max="1000" value="100"></label>
          <label>Total request budget<input type="number" name="maxPagesPerBatch" min="1" max="100000" value="100000"></label>
          <label>Error stop<input type="number" name="maxErrorsPerBatch" min="1" max="1000" value="1000"></label>
          <button type="submit">Prepare collection</button></form></main>${appFooter(hosted)}`,
            'dashboard-page',
          ),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/collections') {
        const form = new URLSearchParams(await readBody(request));
        try {
          const stateCodes = unique(form.getAll('states'));
          if (
            stateCodes.length === 0 ||
            stateCodes.some(
              (code) => !(projectBuilderCatalog.states ?? []).some((state) => state.code === code),
            )
          )
            throw new Error('choose valid states');
          const presets = projectBuilderCatalog.explorerPresets.filter((preset) =>
            form.getAll('presets').includes(preset.key),
          );
          if (presets.length === 0) throw new Error('choose an organization roster');
          const id = await projects.prepareRoster(
            {
              key: `collection-${randomUUID()}`,
              name: form.get('name') ?? '',
              jurisdictionConfigKey: 'source-roster',
              jurisdictionCode: 'source-roster',
              stateCode: stateCodes.length === 1 ? (stateCodes[0] ?? null) : null,
              sectorCodes: unique(presets.flatMap((p) => p.sectorCodes)),
              governmentLevelCodes: projectBuilderCatalog.governmentLevels.map(
                (level) => level.code,
              ),
              filters: {
                organizationTypeCodes: unique(presets.flatMap((p) => p.organizationTypeCodes)),
              },
              batchSize: 1000,
              maxPagesPerTarget: formInteger(form, 'maxPagesPerTarget', 100),
              maxPagesPerBatch: formInteger(form, 'maxPagesPerBatch', 100000),
              maxErrorsPerBatch: formInteger(form, 'maxErrorsPerBatch', 1000),
              createdBy: authenticatedEmail,
            },
            unique(presets.flatMap((p) => p.sourceKeys)),
            stateCodes,
          );
          redirect(response, `/projects/${id}/run`);
        } catch (error) {
          sendHtml(
            response,
            400,
            renderMessage('Collection preparation failed', errorMessage(error)),
          );
        }
        return;
      }
      const contactsMatch = /^\/projects\/([0-9a-f-]+)\/contacts$/.exec(url.pathname);
      if (request.method === 'GET' && contactsMatch !== null) {
        const projectId = contactsMatch[1] as string;
        const project = await projects.get(projectId);
        if (project === null) {
          sendHtml(
            response,
            404,
            renderMessage('Project not found', 'Choose a collection project.'),
          );
          return;
        }
        const after = url.searchParams.get('after') ?? undefined;
        if (after !== undefined && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(after)) {
          sendHtml(
            response,
            400,
            renderMessage('Invalid page', 'Return to the first contacts page.'),
          );
          return;
        }
        const search = (url.searchParams.get('q') ?? '').slice(0, 200);
        const result = await reports.collectedContacts(projectId, search, after);
        const rows = result.contacts
          .map((contact) => {
            let source = '';
            try {
              const parsed = new URL(contact.sourceUrl ?? '');
              if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
                source = `<a href="${escapeAttribute(parsed.href)}" target="_blank" rel="noopener noreferrer">Source</a>`;
            } catch {
              /* Missing source URLs remain blank. */
            }
            return `<tr><td><strong>${escapeHtml(contact.name)}</strong></td><td>${escapeHtml(contact.organization ?? '')}</td><td>${escapeHtml(contact.title ?? '')}<span>${escapeHtml(contact.department ?? '')}</span></td><td>${contact.emails.map(escapeHtml).join('<br>')}</td><td>${contact.phones.map(escapeHtml).join('<br>')}</td><td>${source}</td></tr>`;
          })
          .join('');
        const next =
          result.next === undefined
            ? ''
            : `<a class="secondary-link" href="?${escapeAttribute(new URLSearchParams({ q: search, after: result.next }).toString())}">Next contacts</a>`;
        sendHtml(
          response,
          200,
          page(
            'Collected contacts',
            `${appHeader('/projects', hosted)}<main class="dashboard">
          <section class="dashboard-heading"><div><h1>Collected contacts</h1><p>${escapeHtml(project.name)}</p><p class="muted">Published work contact details for organizations in this project. Shared organizations may have results from an earlier collection.</p></div><a class="primary-link" href="/exports?projectId=${escapeAttribute(projectId)}">Download CSV</a></section>
          <a href="/projects/${escapeAttribute(projectId)}">Back to collection</a>
          <form class="panel panel-body release-form" method="get"><label>Search name, organization, title, or email<input name="q" value="${escapeAttribute(search)}" maxlength="200"></label><button>Search contacts</button><a href="/projects/${escapeAttribute(projectId)}/contacts">Clear search</a></form>
          <section class="panel"><div class="panel-heading"><h2>${result.contacts.length} contacts on this page</h2></div><div class="table-scroll"><table><thead><tr><th>Name</th><th>Organization</th><th>Title / department</th><th>Published email</th><th>Work phone</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No visible contacts on this page. Try clearing your search or check Coverage and exceptions for collection progress. Records without published contact details are not shown.</td></tr>'}</tbody></table></div></section>
          <div class="button-row">${next}<a href="/projects/${escapeAttribute(projectId)}/outcomes">Coverage and exceptions</a></div>
          <p class="muted">The extracted-record count includes repeated observations. This list combines stored contacts and omits suppressed or inactive details. General office inboxes are included when published for the person.</p>
          </main>${appFooter(hosted)}`,
            'dashboard-page',
          ),
        );
        return;
      }
      const outcomeMatch = /^\/projects\/([0-9a-f-]+)\/outcomes$/.exec(url.pathname);
      if (request.method === 'GET' && outcomeMatch !== null) {
        const projectId = outcomeMatch[1] as string;
        const rows = await projects.organizationOutcomes(projectId, url.searchParams.get('after'));
        sendHtml(
          response,
          200,
          page(
            'Collection coverage',
            `${appHeader('/projects', hosted)}<main class="dashboard"><h1>Coverage and exceptions</h1><a href="/projects/${escapeAttribute(projectId)}">Back to collection</a><section class="panel"><table><thead><tr><th>Organization</th><th>Outcome</th><th>People</th><th>Published emails</th><th>Detail</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(String(row['name']))}</td><td>${escapeHtml(String(row['outcome']))}</td><td>${Number(row['people'])}</td><td>${Number(row['published_emails'])}</td><td>${escapeHtml(typeof row['detail'] === 'string' ? row['detail'] : '')}</td></tr>`).join('')}</tbody></table></section>${rows.length === 100 ? `<a href="?after=${escapeAttribute(String(rows.at(-1)?.['id']))}">Next organizations</a>` : ''}</main>${appFooter(hosted)}`,
            'dashboard-page',
          ),
        );
        return;
      }
      const runMatch = /^\/projects\/([0-9a-f-]+)\/run$/.exec(url.pathname);
      if (runMatch !== null) {
        const projectId = runMatch[1] as string;
        const project = await projects.get(projectId);
        if (project === null) {
          sendHtml(
            response,
            404,
            renderMessage('Project not found', 'Choose a collection project.'),
          );
          return;
        }
        if (request.method === 'POST') {
          const form = new URLSearchParams(await readBody(request));
          try {
            if (form.get('approvalConfirmed') !== 'yes')
              throw new Error('confirm this finite discovery and collection run');
            await projects.createApprovedRun({
              projectId,
              approvedBy: authenticatedEmail,
              approvalNote: form.get('approvalNote') ?? '',
              expiresAt: `${form.get('expiresAt') ?? ''}Z`,
            });
            redirect(response, `/projects/${projectId}?message=Collection+run+queued`);
          } catch (error) {
            sendHtml(response, 400, renderMessage('Run could not start', errorMessage(error)));
          }
          return;
        }
        if (request.method === 'GET') {
          const manifest = await projects.domainManifest(projectId);
          sendHtml(
            response,
            200,
            page(
              'Start collection',
              `${appHeader('/projects', hosted)}<main class="dashboard"><h1>${escapeHtml(project.name)}</h1>
            <p>${project.organizationsSelected.toLocaleString()} organizations; ${project.websitesAvailable.toLocaleString()} published websites; ${project.sourceRecordsHeld.toLocaleString()} source rows still unlinked.</p>
            <p>Discovery and scraping proceed automatically within this roster. Source exceptions do not prevent other permitted domains from running.</p>
            <form class="panel panel-body release-form" method="post"><label>Run note<textarea name="approvalNote" minlength="8" required></textarea></label>
            <label>Expires at (UTC)<input name="expiresAt" type="datetime-local" required value="${new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)}"></label>
            <p>At most ${project.maxPagesPerBatch.toLocaleString()} requests, ${project.maxPagesPerTarget} per target, stopping after ${project.maxErrorsPerBatch} errors.</p>
            <label class="check-label"><input name="approvalConfirmed" type="checkbox" value="yes" required><span>I authorize discovery and collection for this finite roster until expiry or the stated limits.</span></label><button>Start collection</button></form>
            <section class="panel panel-body"><h2>Source manifest</h2><p>Review missing policies in bulk below or use the existing policy screen. Prohibited sources remain blocked.</p><table><thead><tr><th>Source</th><th>Status</th></tr></thead><tbody>${manifest.map((row) => `<tr><td><a href="${escapeAttribute(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.url)}</a></td><td>${escapeHtml(row.status)}</td></tr>`).join('')}</tbody></table></section>
            <form class="panel panel-body release-form" method="post" action="/projects/${projectId}/policies/bulk"><h2>Record reviewed source decisions</h2><p>One reviewed domain per line: domain | what you checked. Each line records its own review and production approval.</p><textarea name="decisions" rows="8" required></textarea><label class="check-label"><input type="checkbox" name="approvalConfirmed" value="yes" required><span>I reviewed these sources and approve collection from them.</span></label><button>Record decisions and resume eligible work</button></form>
            </main>${appFooter(hosted)}`,
              'dashboard-page',
            ),
          );
          return;
        }
      }
      const bulkPolicyMatch = /^\/projects\/([0-9a-f-]+)\/policies\/bulk$/.exec(url.pathname);
      if (request.method === 'POST' && bulkPolicyMatch !== null) {
        const projectId = bulkPolicyMatch[1] as string;
        const form = new URLSearchParams(await readBody(request));
        try {
          if (form.get('approvalConfirmed') !== 'yes')
            throw new Error('confirm the source decisions');
          const manifest = await projects.domainManifest(projectId);
          const lines = (form.get('decisions') ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length === 0 || lines.length > 1000)
            throw new Error('provide between 1 and 1000 source decisions');
          const decisions = lines.map((line) => {
            const separator = line.indexOf('|');
            const domain = line.slice(0, separator).trim().toLowerCase();
            const note = line.slice(separator + 1).trim();
            if (separator < 0 || note.length < 8 || !manifest.some((row) => row.domain === domain))
              throw new Error('each decision needs a manifest domain and review evidence');
            if (manifest.some((row) => row.domain === domain && row.status === 'prohibited'))
              throw new Error('a prohibited source cannot be approved');
            return { domain, note };
          });
          for (const decision of decisions) {
            const id = await sourcePolicies.recordReview({
              domain: decision.domain,
              collectionStatus: 'review_required',
              automatedAccessStatus: 'unknown',
              commercialUseStatus: 'unknown',
              solicitationStatus: 'unknown',
              reviewedBy: authenticatedEmail,
              reviewNotes: decision.note,
            });
            await sourcePolicies.approve(id, authenticatedEmail, decision.note);
          }
          await projects.resumePolicyHolds(projectId, authenticatedEmail);
          redirect(response, `/projects/${projectId}/run`);
        } catch (error) {
          sendHtml(response, 400, renderMessage('Source decisions failed', errorMessage(error)));
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/projects/new') {
        sendHtml(
          response,
          200,
          renderNewProject(projectTemplates, projectBuilderCatalog, '', hosted),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/assets/project-builder.js') {
        sendJavascript(response, PROJECT_BUILDER_SCRIPT);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/assets/organization-records.js') {
        sendJavascript(response, ORGANIZATION_RECORDS_SCRIPT);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/projects') {
        const form = new URLSearchParams(await readBody(request));
        const templateKey = form.get('template') ?? '';
        const template = projectTemplates.find((item) => item.key === templateKey);
        if (template === undefined) {
          sendHtml(
            response,
            400,
            renderNewProject(
              projectTemplates,
              projectBuilderCatalog,
              'Choose a configured scope.',
              hosted,
            ),
          );
          return;
        }
        try {
          const selectedStateCode = form.get('stateCode') ?? template.stateCode ?? 'National';
          const selectedGovernmentLevel =
            form.get('governmentLevelCode') ?? template.governmentLevelCode;
          const selectedSector = form.get('sectorCode') ?? template.sectorCodes[0];
          const stateMatches =
            template.stateCode === null
              ? selectedStateCode === 'National' ||
                (projectBuilderCatalog.states ?? []).some(
                  (state) => state.code === selectedStateCode,
                )
              : selectedStateCode === template.stateCode;
          if (
            !stateMatches ||
            selectedGovernmentLevel !== template.governmentLevelCode ||
            selectedSector === undefined ||
            !template.sectorCodes.includes(selectedSector)
          ) {
            throw new Error(
              'the selected state, government level, and sector need a matching reviewed jurisdiction configuration',
            );
          }
          const workMode = form.get('workMode');
          if (
            workMode !== null &&
            workMode !== 'approved_batch_complete' &&
            workMode !== 'operator_job_limit'
          ) {
            throw new Error('choose a supported workload behavior');
          }
          const organizationTypeCodes = form.getAll('organizationTypes');
          const knownOrganizationTypes = new Set(
            projectBuilderCatalog.organizationTypes.map((item) => item.code),
          );
          if (organizationTypeCodes.some((code) => !knownOrganizationTypes.has(code))) {
            throw new Error('choose organization types from the available taxonomy');
          }
          const projectId = await projects.create({
            key: `${slug(form.get('name') ?? template.name)}-${randomUUID().slice(0, 8)}`,
            name: form.get('name') ?? template.name,
            jurisdictionConfigKey: template.key,
            jurisdictionCode: template.jurisdictionCode,
            stateCode: selectedStateCode === 'National' ? null : selectedStateCode,
            sectorCodes: [selectedSector],
            governmentLevelCodes: [selectedGovernmentLevel],
            filters: {
              organizationTypeCodes,
              includedOrganizationIds: commaList(form.get('includeOrganizations')),
              excludedOrganizationIds: commaList(form.get('excludeOrganizations')),
              workMode:
                workMode === 'operator_job_limit'
                  ? 'operator_job_limit'
                  : 'approved_batch_complete',
            },
            estimatedOrganizationCount: null,
            batchSize: formInteger(form, 'batchSize', 10),
            maxPagesPerTarget: formInteger(
              form,
              'maxPagesPerTarget',
              template.defaultMaxPagesPerTarget ?? 10,
            ),
            maxPagesPerBatch: formInteger(form, 'maxPagesPerBatch', 100),
            maxErrorsPerBatch: formInteger(form, 'maxErrorsPerBatch', 3),
            createdBy: authenticatedEmail,
          });
          redirect(response, `/projects/${projectId}?message=Project+created`);
        } catch (error) {
          sendHtml(
            response,
            400,
            renderNewProject(projectTemplates, projectBuilderCatalog, errorMessage(error), hosted),
          );
        }
        return;
      }

      const projectMatch = /^\/projects\/([0-9a-f-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && projectMatch !== null) {
        const projectId = projectMatch[1] as string;
        const project = await projects.get(projectId);
        if (project === null) {
          sendHtml(
            response,
            404,
            renderMessage('Project not found', 'Return to collection projects.'),
          );
          return;
        }
        const template = projectTemplates.find(
          (item) => item.key === project.jurisdictionConfigKey,
        );
        const [batches, policyHolds] = await Promise.all([
          projects.listBatches(projectId),
          projects.listPolicyHolds(projectId),
        ]);
        sendHtml(
          response,
          200,
          renderProjectDetail(
            project,
            batches,
            policyHolds,
            template,
            url.searchParams.get('message') ?? '',
            hosted,
          ),
        );
        return;
      }

      const projectAction = /^\/projects\/([0-9a-f-]+)\/(refresh|generate|status|batch)$/.exec(
        url.pathname,
      );
      if (request.method === 'POST' && projectAction !== null) {
        const projectId = projectAction[1] as string;
        const action = projectAction[2] as string;
        const form = new URLSearchParams(await readBody(request));
        try {
          let message = 'Project updated';
          if (action === 'refresh') {
            const count = await projects.refreshOrganizations(projectId);
            message = `${count} new organizations selected`;
          } else if (action === 'generate') {
            const count = await projects.generateDiscoveryTargets(projectId, authenticatedEmail);
            message = `${count} discovery targets created`;
          } else if (action === 'status') {
            const status = form.get('status');
            if (status !== 'active' && status !== 'paused' && status !== 'completed') {
              throw new Error('unsupported project status');
            }
            await projects.setStatus(projectId, status, authenticatedEmail);
            message = `Project ${status}`;
          } else {
            if (form.get('approvalConfirmed') !== 'yes') {
              throw new Error('confirm that you approve this exact finite batch');
            }
            const kind = form.get('kind');
            if (kind !== 'discovery' && kind !== 'crawl') throw new Error('choose a batch kind');
            await projects.createApprovedBatch({
              projectId,
              kind,
              targetLimit: formInteger(form, 'targetLimit', 10),
              approvedBy: authenticatedEmail,
              approvalNote: form.get('approvalNote') ?? '',
            });
            message = `${label(kind)} batch approved and queued`;
          }
          redirect(response, `/projects/${projectId}?message=${encodeURIComponent(message)}`);
        } catch (error) {
          redirect(
            response,
            `/projects/${projectId}?message=${encodeURIComponent(errorMessage(error))}`,
          );
        }
        return;
      }

      sendHtml(response, 404, renderMessage('Page not found', 'Return to the operator console.'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(JSON.stringify({ event: 'admin_request_failed', message }));
      sendHtml(
        response,
        500,
        renderMessage(
          'The operator console hit an error',
          'The database is still safe. Try refreshing.',
        ),
      );
    }
  };

  return createServer((request, response) => {
    void handleRequest(request, response);
  });
}

function filterRecords(records: DataQualitySample[], query: string): DataQualitySample[] {
  if (query.length === 0) return records;
  const needle = query.toLocaleLowerCase();
  return records.filter((record) =>
    [
      record.fullNamePublished,
      record.titlePublished,
      record.organizationName,
      record.emailClassification,
      record.governmentLevelCode,
    ].some((value) => value?.toLocaleLowerCase().includes(needle) === true),
  );
}

function authenticatedUser(
  request: IncomingMessage,
  cookieName: string,
  secret: string,
  now: Date,
): string | null {
  const cookieHeader = request.headers.cookie ?? '';
  const token = cookieHeader
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === cookieName)?.[1];
  if (token === undefined) return null;

  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const receivedSignature = token.slice(separator + 1);
  const expectedSignature = sign(payload, secret);
  if (!secureEqual(receivedSignature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
      expiresAt?: unknown;
    };
    return typeof parsed.email === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > now.getTime()
      ? parsed.email
      : null;
  } catch {
    return null;
  }
}

function isAuthenticated(
  request: IncomingMessage,
  cookieName: string,
  secret: string,
  now: Date,
): boolean {
  return authenticatedUser(request, cookieName, secret, now) !== null;
}

function createSessionToken(email: string, expiresAt: number, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ email, expiresAt }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function hashAdminPassword(password: string, salt: string = randomUUID()): string {
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${Buffer.from(salt, 'utf8').toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyAdminPassword(
  password: string,
  plainPassword: string | undefined,
  encodedHash: string | undefined,
): boolean {
  if (encodedHash === undefined) {
    return plainPassword !== undefined && secureEqual(password, plainPassword);
  }
  const [algorithm, n, r, p, saltValue, hashValue, ...rest] = encodedHash.split('$');
  if (
    algorithm !== 'scrypt' ||
    n !== '32768' ||
    r !== '8' ||
    p !== '1' ||
    saltValue === undefined ||
    hashValue === undefined ||
    rest.length > 0
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, 'base64url').toString('utf8');
    const expected = Buffer.from(hashValue, 'base64url');
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function clientLoginKey(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const client = Array.isArray(forwarded)
    ? (forwarded[0] ?? request.socket.remoteAddress ?? 'unknown')
    : (forwarded?.split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown');
  return createHash('sha256').update(client).digest('hex');
}

function isTrustedMutationRequest(request: IncomingMessage, publicOrigin: string): boolean {
  const expected = new URL(publicOrigin);
  const origin = request.headers.origin;
  if (origin === expected.origin) return true;
  if (origin !== undefined && origin !== 'null') return false;

  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (
    Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost?.split(',')[0]
  )?.trim();
  const requestHost = host ?? request.headers.host;
  return requestHost === expected.host;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 16_384) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function setSecurityHeaders(response: ServerResponse, hosted: boolean): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  if (hosted)
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader('Location', location);
  response.end();
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function sendCsv(response: ServerResponse, csv: string, filename: string, exportId: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.setHeader('X-Export-ID', exportId);
  response.end(csv);
}

function sendJavascript(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  response.end(body);
}

function renderLogin(hosted: boolean, error = ''): string {
  return page(
    'Sign in',
    `<main class="login-shell">
      <section class="login-brand" aria-labelledby="brand-title">
        <div class="brand-mark" aria-hidden="true">PW</div>
        <p class="eyebrow">Public Workforce Data</p>
        <h1 id="brand-title">Evidence you can inspect.</h1>
        <p class="brand-copy">Review collection runs, coverage, provenance, and data quality from a private ${hosted ? 'hosted' : 'local'} console.</p>
        <div class="boundary-note">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Public professional data only. Collection still requires an approved batch.</span>
        </div>
      </section>
      <section class="login-panel" aria-labelledby="login-title">
        <div class="login-card">
          <p class="eyebrow">Operator access</p>
          <h2 id="login-title">Welcome back</h2>
          <p class="muted">Use the operator credentials configured for this ${hosted ? 'service' : 'workspace'}.</p>
          ${error.length > 0 ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
          <form method="post" action="/login">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required autofocus>
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
            <button type="submit">Sign in to console</button>
          </form>
          <p class="fine-print">${hosted ? 'This session is protected by HTTPS and a secure, signed cookie.' : 'This console listens only on your computer. The credentials are not valid for any cloud service.'}</p>
        </div>
      </section>
    </main>`,
    'login-page',
  );
}

function renderDashboard(data: DashboardData, query: string, hosted: boolean): string {
  const latestRun = data.runs[0];
  const lastCrawl = data.coverage.lastCrawlAt;
  const records = data.records
    .map(
      (record) => `<tr>
        <td><strong>${escapeHtml(record.fullNamePublished)}</strong><span>${escapeHtml(record.titlePublished ?? 'Title not published')}</span></td>
        <td>${escapeHtml(record.organizationName ?? 'Organization unavailable')}</td>
        <td><span class="pill">${escapeHtml(label(record.governmentLevelCode))}</span></td>
        <td>${escapeHtml(label(record.emailClassification ?? 'not published'))}</td>
        <td><div class="confidence"><span style="width:${Math.round(record.confidence * 100)}%"></span></div><small>${Math.round(record.confidence * 100)}%</small></td>
      </tr>`,
    )
    .join('');
  const runs = data.runs
    .map(
      (run) => `<tr>
        <td><span class="run-status ${escapeHtml(run.status)}"></span>${escapeHtml(label(run.status))}</td>
        <td>${escapeHtml(label(run.runType))}</td>
        <td>${formatDate(run.startedAt)}</td>
        <td>${run.pagesFetched}</td>
        <td>${run.recordsExtracted}</td>
        <td>${run.errors}</td>
      </tr>`,
    )
    .join('');
  const breakdown = data.organizations
    .map(
      (item) =>
        `<li><span>${escapeHtml(label(item.organizationTypeCode))}<small>${escapeHtml(label(item.governmentLevelCode))}</small></span><strong>${item.count}</strong></li>`,
    )
    .join('');

  return page(
    'Operator console',
    `<div class="app-shell">
      <header class="topbar">
        <a class="wordmark" href="/" aria-label="Public Workforce Data home"><span class="brand-mark small">PW</span><span>Public Workforce Data<small>Operator console</small></span></a>
        <div class="topbar-actions"><a class="nav-link" href="/spine">Organization spine</a><a class="nav-link" href="/organization-records">Explore organizations</a><a class="nav-link" href="/projects">Collection projects</a><a class="nav-link" href="/policies">Source policies</a><a class="nav-link" href="/exports">Exports</a><span class="local-badge"><span class="status-dot"></span>${hosted ? 'Hosted service' : 'Local workspace'}</span><form method="post" action="/logout"><button class="quiet-button" type="submit">Sign out</button></form></div>
      </header>
      <main class="dashboard">
        <section class="dashboard-heading">
          <div><p class="eyebrow">Collection overview</p><h1>Good ${timeOfDay()}, operator.</h1><p class="muted">A clear view of what the governed pipeline collected and preserved.</p></div>
          <div class="freshness"><span>Last collection run</span><strong>${lastCrawl === null ? 'Not run yet' : formatDate(lastCrawl)}</strong></div>
        </section>

        <section class="notice"><span class="shield" aria-hidden="true">✓</span><div><strong>Governed collection</strong><p>No source is contacted unless a person approves a finite batch and the source policy allows it.</p></div></section>

        <section class="metrics" aria-label="Coverage summary">
          ${metric('People', data.coverage.people, 'Public role records')}
          ${metric('Published emails', data.coverage.publishedEmails, 'Work addresses from source')}
          ${metric('Organizations', data.coverage.organizations, `${data.coverage.governmentLevels} government level${data.coverage.governmentLevels === 1 ? '' : 's'}`)}
          ${metric('Suppressions', data.coverage.suppressionEntries, 'Active safeguards')}
        </section>

        <div class="content-grid">
        <section class="panel records-panel">
            <div class="panel-heading"><div><p class="eyebrow">Evidence sample</p><h2>Collected records</h2></div><form class="search" method="get" action="/"><label class="sr-only" for="q">Search records</label><input id="q" name="q" value="${escapeAttribute(query)}" placeholder="Search name, role, organization"><button type="submit">Search</button></form></div>
            <div class="table-scroll"><table><thead><tr><th>Person and role</th><th>Organization</th><th>Level</th><th>Email evidence</th><th>Confidence</th></tr></thead><tbody>${records.length > 0 ? records : `<tr><td class="empty" colspan="5">${query.length > 0 ? 'No records match this search.' : 'No records have been collected yet.'}</td></tr>`}</tbody></table></div>
            <p class="table-note">Names and titles stay exactly as published. Normalized values do not replace source evidence.</p>
          </section>

          <aside class="panel breakdown-panel">
            <div class="panel-heading"><div><p class="eyebrow">Footprint</p><h2>Organizations</h2></div></div>
            <ul class="breakdown">${breakdown.length > 0 ? breakdown : '<li class="empty">No organizations yet.</li>'}</ul>
          </aside>
        </div>

        <section class="panel runs-panel">
          <div class="panel-heading"><div><p class="eyebrow">Pipeline activity</p><h2>Recent collection runs</h2></div>${latestRun === undefined ? '' : `<span class="summary-chip">${latestRun.errors === 0 ? 'All clear' : `${latestRun.errors} errors`}</span>`}</div>
          <div class="table-scroll"><table><thead><tr><th>Status</th><th>Mode</th><th>Started</th><th>Pages</th><th>Records</th><th>Errors</th></tr></thead><tbody>${runs.length > 0 ? runs : '<tr><td class="empty" colspan="6">No collection runs yet.</td></tr>'}</tbody></table></div>
        </section>
      </main>
      <footer><span>${hosted ? 'Hosted' : 'Local'} review surface</span><span>Public professional data only</span></footer>
    </div>`,
    'dashboard-page',
  );
}

interface OrganizationRecordViewFilters {
  query: string;
  stateCode: string;
  websiteAvailability: 'all' | 'published' | 'missing';
  page: number;
  message: string;
}

function renderOrganizationRecords(
  preset: OrganizationExplorerPreset,
  result: OrganizationRecordPage,
  projects: readonly CollectionProjectSummary[],
  catalog: ProjectBuilderCatalog,
  filters: OrganizationRecordViewFilters,
  hosted: boolean,
): string {
  const projectOptions = selectableProjectOptions(projects);
  const columnHeaders = preset.attributeColumns
    .slice(0, 3)
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join('');
  const rows = result.records
    .map((record) => {
      const location = record.location;
      const locality = [location['city'], location['stateCode']]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(', ');
      const columns = preset.attributeColumns
        .slice(0, 3)
        .map(
          (column) =>
            `<td>${escapeHtml(formatExplorerValue(record.attributes[column.key], column.format))}</td>`,
        )
        .join('');
      return `<tr>
        <td><input type="checkbox" name="recordIds" value="${escapeAttribute(record.id)}" aria-label="Select ${escapeAttribute(record.name)}"></td>
        <td><a class="table-link" href="/organization-records/${escapeAttribute(record.id)}?preset=${escapeAttribute(preset.key)}"><strong>${escapeHtml(record.name)}</strong></a><span>${escapeHtml(record.sourceRecordKey)} · ${escapeHtml(locality || 'Location not published')}</span></td>
        ${columns}
        <td>${record.websiteUrl === null ? 'Not published' : `<a class="table-link" href="${escapeAttribute(record.websiteUrl)}" target="_blank" rel="noreferrer">Open website</a>`}</td>
        <td><span class="project-status ${record.organizationId === null ? 'paused' : 'active'}">${record.organizationId === null ? 'Awaiting classification' : 'Collection-ready'}</span></td>
      </tr>`;
    })
    .join('');
  const pageCount = Math.max(1, Math.ceil(result.total / result.limit));
  const presetLinks = catalog.explorerPresets
    .map(
      (item) =>
        `<a class="secondary-link${item.key === preset.key ? ' selected-filter' : ''}" href="/organization-records?preset=${escapeAttribute(item.key)}">${escapeHtml(item.name)}</a>`,
    )
    .join('');
  const states = catalog.states ?? [];
  const returnTo = explorerUrl(preset.key, filters);
  const from = result.total === 0 ? 0 : result.offset + 1;
  const to = Math.min(result.offset + result.records.length, result.total);

  return page(
    `${preset.name} explorer`,
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading">
        <div><p class="eyebrow">Official organization data</p><h1>${escapeHtml(preset.name)} explorer</h1><p class="muted">${escapeHtml(preset.description)}</p></div>
        <span class="summary-chip">${result.total.toLocaleString()} records</span>
      </section>
      ${filters.message.length > 0 ? `<div class="flash">${escapeHtml(filters.message)}</div>` : ''}
      <section class="notice"><span class="shield">i</span><div><strong>Selection does not start collection</strong><p>Add records to a project now. Records awaiting authoritative classification remain held and cannot become crawl targets until that classification is supported.</p></div></section>
      <nav class="preset-links" aria-label="Organization explorers">${presetLinks}</nav>
      <section class="panel project-section">
        <form class="spine-filters explorer-filters" method="get" action="/organization-records">
          <input type="hidden" name="preset" value="${escapeAttribute(preset.key)}">
          <label>Search<input name="q" value="${escapeAttribute(filters.query)}" placeholder="Name or official ID"></label>
          ${filterSelect('stateCode', 'State', filters.stateCode, states)}
          <label>Website<select name="website"><option value="all"${filters.websiteAvailability === 'all' ? ' selected' : ''}>All</option><option value="published"${filters.websiteAvailability === 'published' ? ' selected' : ''}>Published</option><option value="missing"${filters.websiteAvailability === 'missing' ? ' selected' : ''}>Missing</option></select></label>
          <button type="submit">Apply filters</button><a class="secondary-link" href="/organization-records?preset=${escapeAttribute(preset.key)}">Clear</a>
        </form>
        <form method="post" action="/organization-records/projects" data-record-selection>
          <input type="hidden" name="preset" value="${escapeAttribute(preset.key)}">
          <input type="hidden" name="returnTo" value="${escapeAttribute(returnTo)}">
          <div class="bulk-toolbar">
            <button class="secondary-button" type="button" data-select-page>Select this page</button>
            <button class="secondary-button" type="button" data-clear-page>Clear selection</button>
            <label>Collection project<select name="projectId" required ${projectOptions.length === 0 ? 'disabled' : ''}><option value="">Choose a project</option>${projectOptions}</select></label>
            <button type="submit" ${projectOptions.length === 0 ? 'disabled' : ''}>Add selected to project</button>
          </div>
          <div class="table-scroll"><table><thead><tr><th>Select</th><th>${escapeHtml(preset.singularName)}</th>${columnHeaders}<th>Website</th><th>Collection state</th></tr></thead><tbody>${rows.length > 0 ? rows : `<tr><td class="empty" colspan="${preset.attributeColumns.slice(0, 3).length + 4}">No records match these filters.</td></tr>`}</tbody></table></div>
        </form>
        <div class="pagination"><span>Showing ${from.toLocaleString()}-${to.toLocaleString()} of ${result.total.toLocaleString()}</span><div>${filters.page > 1 ? `<a class="secondary-link" href="${escapeAttribute(explorerUrl(preset.key, { ...filters, page: filters.page - 1, message: '' }))}">Previous</a>` : ''}${filters.page < pageCount ? `<a class="secondary-link" href="${escapeAttribute(explorerUrl(preset.key, { ...filters, page: filters.page + 1, message: '' }))}">Next</a>` : ''}</div></div>
        ${projectOptions.length === 0 ? '<p class="table-note">Create a collection project before adding records. The project remains a draft until a separate batch is approved.</p>' : '<p class="table-note">Bulk selection records your intended scope. It does not contact any public website or release worker jobs.</p>'}
      </section>
    </main>${appFooter(hosted)}<script src="/assets/organization-records.js" defer></script>`,
    'dashboard-page',
  );
}

function renderOrganizationRecordProfile(
  record: OrganizationSourceRecord,
  preset: OrganizationExplorerPreset | null,
  projects: readonly CollectionProjectSummary[],
  message: string,
  hosted: boolean,
): string {
  const columns = preset?.attributeColumns ?? [];
  const primaryKeys = new Set(columns.map((column) => column.key));
  const primaryAttributes = columns
    .map(
      (column) =>
        `<div><dt>${escapeHtml(column.label)}</dt><dd>${escapeHtml(formatExplorerValue(record.attributes[column.key], column.format))}</dd></div>`,
    )
    .join('');
  const otherAttributes = Object.entries(record.attributes)
    .filter(([key]) => !primaryKeys.has(key))
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(label(key))}</dt><dd>${escapeHtml(formatExplorerValue(value, 'text'))}</dd></div>`,
    )
    .join('');
  const location = record.location;
  const address = [
    location['addressLine1'],
    location['addressLine2'],
    [location['city'], location['stateCode'], location['postalCode']]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(' '),
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(', ');
  const identifiers = [...record.identifiers, ...record.parentIdentifiers]
    .map((identifier) => {
      const system = primitiveText(identifier['systemCode'] ?? identifier['system'], 'identifier');
      const value = primitiveText(identifier['value'], 'Not published');
      return `<li><strong>${escapeHtml(label(system))}</strong><span>${escapeHtml(value)}</span></li>`;
    })
    .join('');
  const projectOptions = selectableProjectOptions(projects);
  const backPath = `/organization-records${preset === null ? '' : `?preset=${encodeURIComponent(preset.key)}`}`;
  return page(
    record.name,
    `${appHeader(backPath, hosted)}
    <main class="dashboard narrow-dashboard">
      <section class="dashboard-heading">
        <div><p class="eyebrow">${escapeHtml(preset?.singularName ?? 'Organization')} profile</p><h1>${escapeHtml(record.name)}</h1><p class="muted">Official source record ${escapeHtml(record.sourceRecordKey)}</p></div>
        <span class="project-status large ${record.organizationId === null ? 'paused' : 'active'}">${record.organizationId === null ? 'Awaiting classification' : 'Collection-ready'}</span>
      </section>
      ${message.length > 0 ? `<div class="flash">${escapeHtml(message)}</div>` : ''}
      <section class="metrics">
        ${primaryAttributes.length > 0 ? primaryAttributes.replaceAll('<div>', '<article class="metric-card">').replaceAll('</div>', '</article>').replaceAll('<dt>', '<span>').replaceAll('</dt>', '</span>').replaceAll('<dd>', '<strong>').replaceAll('</dd>', '</strong>') : metric('Published attributes', Object.keys(record.attributes).length, 'Values preserved from the official source')}
      </section>
      <div class="project-grid">
        <section class="panel panel-body"><p class="eyebrow">Published details</p><h2>Location and website</h2><dl class="profile-details"><div><dt>Address</dt><dd>${escapeHtml(address || 'Not published')}</dd></div><div><dt>Website</dt><dd>${record.websiteUrl === null ? 'Not published' : `<a class="table-link" href="${escapeAttribute(record.websiteUrl)}" target="_blank" rel="noreferrer">${escapeHtml(record.websiteUrl)}</a>`}</dd></div><div><dt>Classification</dt><dd>${escapeHtml(
          [record.organizationTypeCode, record.governmentLevelCode, record.sectorCode]
            .filter(Boolean)
            .map((value) => label(String(value)))
            .join(' · ') || 'Incomplete',
        )}</dd></div></dl></section>
        <section class="panel panel-body"><p class="eyebrow">Official identity</p><h2>Identifiers</h2><ul class="breakdown profile-identifiers">${identifiers.length > 0 ? identifiers : '<li>No identifiers were published.</li>'}</ul></section>
      </div>
      ${otherAttributes.length > 0 ? `<section class="panel panel-body project-section"><p class="eyebrow">Additional source values</p><dl class="profile-details attribute-grid">${otherAttributes}</dl></section>` : ''}
      <section class="panel panel-body project-section"><p class="eyebrow">Provenance</p><h2>Where this came from</h2><dl class="profile-details"><div><dt>Official source</dt><dd><a class="table-link" href="${escapeAttribute(record.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(record.sourceKey)}</a></dd></div><div><dt>Source effective date</dt><dd>${escapeHtml(record.sourceEffectiveDate ?? 'Not published')}</dd></div><div><dt>Retrieved</dt><dd>${formatDate(record.sourceRetrievedAt)}</dd></div><div><dt>Evidence version</dt><dd>${record.sourceVersion} · ${escapeHtml(record.sourceContentHash.slice(0, 16))}</dd></div></dl></section>
      ${record.organizationId === null ? `<section class="warning-card"><strong>This record is preserved but not yet crawl-ready.</strong><p>${escapeHtml(record.classificationReviewReason ?? 'Authoritative classification is required before canonical import.')}</p></section>` : ''}
      <section class="panel panel-body project-section"><p class="eyebrow">Project scope</p><h2>Add this organization</h2><p>This records the intended scope only. It does not create or approve a collection batch.</p><form class="release-form" method="post" action="/organization-records/projects"><input type="hidden" name="recordIds" value="${escapeAttribute(record.id)}"><input type="hidden" name="preset" value="${escapeAttribute(preset?.key ?? '')}"><input type="hidden" name="returnTo" value="/organization-records/${escapeAttribute(record.id)}"><label>Collection project<select name="projectId" required ${projectOptions.length === 0 ? 'disabled' : ''}><option value="">Choose a project</option>${projectOptions}</select></label><button type="submit" ${projectOptions.length === 0 ? 'disabled' : ''}>Add to project</button></form>${projectOptions.length === 0 ? '<p class="table-note">Create a collection project first.</p>' : ''}</section>
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function renderOrganizationSpine(
  summary: OrganizationSpineSummary,
  queue: readonly MissingWebsiteOrganization[],
  inventory: OrganizationSpineInventory | undefined,
  catalog: ProjectBuilderCatalog,
  filters: SpineFilters,
  hosted: boolean,
): string {
  const sourceRows = (inventory?.sources ?? [])
    .map(
      (source) => `<tr>
        <td><a class="table-link" href="${escapeAttribute(source.catalogUrl)}" target="_blank" rel="noreferrer"><strong>${escapeHtml(source.name)}</strong></a><span>${escapeHtml(source.key)}</span></td>
        <td>${source.records.toLocaleString()}</td>
        <td>${source.publishedWebsites.toLocaleString()}</td>
        <td>${source.missingWebsites.toLocaleString()}</td>
        <td><span class="project-status active">Organized locally</span></td>
      </tr>`,
    )
    .join('');
  const geographyRows = (inventory?.geographies ?? [])
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.name)}<small>${escapeHtml(item.code)}</small></span><strong>${item.records.toLocaleString()}</strong></li>`,
    )
    .join('');
  const queueRows = queue
    .map(
      (item) => `<tr>
        <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.id)}</span></td>
        <td>${escapeHtml(label(item.organizationTypeCode))}<span>${escapeHtml(label(item.governmentLevelCode))} · ${escapeHtml(label(item.sectorCode))}</span></td>
        <td>${escapeHtml([item.city, item.stateCode, item.postalCode].filter(Boolean).join(', ') || 'Not published')}</td>
        <td>${item.identifiers.length === 0 ? 'No official identifier loaded' : item.identifiers.map((identifier) => `${escapeHtml(label(identifier.systemCode))}: ${escapeHtml(identifier.value)}`).join('<br>')}</td>
        <td>${item.proposedCandidates.toLocaleString()}<span>${item.bestCandidateConfidence === null ? 'No candidate yet' : `${Math.round(item.bestCandidateConfidence * 100)}% best confidence`}</span></td>
      </tr>`,
    )
    .join('');
  const stagingLoaded = summary.stagedSourceRows > 0;
  const importStarted = summary.organizations > 0;
  const states = inventory?.states ?? [];
  const notes = (inventory?.notes ?? []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');

  return page(
    'Organization spine',
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading">
        <div><p class="eyebrow">National source inventory</p><h1>Organization spine</h1><p class="muted">See what has been organized, what is actually loaded here, and what is ready for public professional directory collection.</p></div>
        <div class="freshness"><span>Staging manifest</span><strong>${inventory === undefined ? 'Not registered' : formatDate(inventory.generatedAt)}</strong></div>
      </section>

      <section class="status-track" aria-label="Organization pipeline status">
        ${pipelineStage('1', 'Official source files', inventory === undefined ? 'No manifest registered' : `${inventory.sourceRows.toLocaleString()} rows organized`, inventory !== undefined)}
        ${pipelineStage('2', 'Hosted database staging', stagingLoaded ? `${summary.stagedSourceRows.toLocaleString()} source rows staged` : 'Not loaded', stagingLoaded)}
        ${pipelineStage('3', 'Website resolution', summary.missingWebsites === 0 && !importStarted ? 'Waiting for import' : `${summary.missingWebsites.toLocaleString()} missing · ${summary.proposedWebsiteCandidates.toLocaleString()} proposed`, summary.proposedWebsiteCandidates > 0)}
        ${pipelineStage('4', 'Directory collection', summary.publishedWebsites === 0 ? 'Waiting for websites' : `${summary.publishedWebsites.toLocaleString()} organizations have a website`, summary.publishedWebsites > 0)}
      </section>

      <section class="metrics" aria-label="Staged source coverage">
        ${metric('Source rows organized', inventory?.sourceRows ?? 0, 'Source records, overlays, and held rows')}
        ${metric('Published website values', inventory?.publishedWebsiteValues ?? 0, 'Values present in source rows')}
        ${metric('Post-overlay website queue', inventory?.missingWebsiteQueue ?? 0, `${inventory?.exactWebsiteOverlays.toLocaleString() ?? '0'} exact identifier overlays found`)}
        ${metric('Geographic areas', inventory?.geographicAreas ?? 0, `${inventory?.relationships.toLocaleString() ?? '0'} organization relationships staged`)}
      </section>

      <section class="notice"><span class="shield" aria-hidden="true">i</span><div><strong>Staged is not loaded</strong><p>The source inventory above describes the preserved organizer output. The database cards below count only canonical records in the database this console is currently using.</p></div></section>

      <section class="metrics" aria-label="Hosted database coverage">
        ${metric('Source rows staged', summary.stagedSourceRows, `${summary.readyToImport.toLocaleString()} ready · ${summary.importedSourceRows.toLocaleString()} imported`)}
        ${metric('Organizations loaded', summary.organizations, `${summary.governmentLevels} levels · ${summary.sectors} sectors`)}
        ${metric('Websites ready', summary.publishedWebsites, 'Available for governed directory discovery')}
        ${metric('Websites missing', summary.missingWebsites, `${summary.proposedWebsiteCandidates} candidates awaiting review`)}
      </section>

      <div class="content-grid spine-grid">
        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Provenance inventory</p><h2>Organized sources</h2></div><span class="summary-chip">${inventory?.sources.length ?? 0} source slices</span></div>
          <div class="table-scroll"><table><thead><tr><th>Source</th><th>Rows</th><th>Websites</th><th>Missing</th><th>State</th></tr></thead><tbody>${sourceRows.length > 0 ? sourceRows : '<tr><td class="empty" colspan="5">No staging manifest is registered in this build.</td></tr>'}</tbody></table></div>
        </section>
        <aside class="panel breakdown-panel">
          <div class="panel-heading"><div><p class="eyebrow">Geographic spine</p><h2>Area coverage</h2></div></div>
          <ul class="breakdown">${geographyRows.length > 0 ? geographyRows : '<li class="empty">No staged geographies.</li>'}</ul>
        </aside>
      </div>

      <section class="panel project-section">
        <div class="panel-heading"><div><p class="eyebrow">Durable work queue</p><h2>Organizations missing a website</h2></div><span class="summary-chip">Showing ${queue.length.toLocaleString()} of ${summary.missingWebsites.toLocaleString()}</span></div>
        <form class="spine-filters" method="get" action="/spine">
          ${filterSelect('governmentLevelCode', 'Government level', filters.governmentLevelCode, catalog.governmentLevels)}
          ${filterSelect('sectorCode', 'Sector', filters.sectorCode, catalog.sectors)}
          ${filterSelect('stateCode', 'State', filters.stateCode, states)}
          ${filterSelect('organizationTypeCode', 'Organization type', filters.organizationTypeCode, catalog.organizationTypes)}
          <button type="submit">Apply filters</button><a class="secondary-link" href="/spine">Clear</a>
        </form>
        <div class="table-scroll"><table><thead><tr><th>Organization</th><th>Classification</th><th>Location</th><th>Official identifiers</th><th>Candidates</th></tr></thead><tbody>${queueRows.length > 0 ? queueRows : `<tr><td class="empty" colspan="5">${importStarted ? 'No organizations match these filters.' : 'The staged organization files have not been imported into this database yet.'}</td></tr>`}</tbody></table></div>
        <p class="table-note">A proposed search result never becomes the canonical website automatically. Exact identifiers may attach official overlays; every other candidate remains reviewable evidence.</p>
      </section>

      <section class="work-summary">
        <article class="warning-card"><strong>${stagingLoaded ? summary.classificationHolds.toLocaleString() : (inventory?.classificationWork.toLocaleString() ?? '0')} classification actions remain</strong><p>Controlled mappings, authoritative crosswalks, and parent inheritance are tracked instead of guessed.</p></article>
        <article class="warning-card"><strong>${stagingLoaded ? summary.reconciliationHolds.toLocaleString() : (inventory?.reconciliationRequired.toLocaleString() ?? '0')} records require reconciliation</strong><p>${summary.overlayHolds.toLocaleString()} staged overlays also wait for exact identifier attachment.</p></article>
      </section>
      ${notes.length === 0 ? '' : `<section class="panel project-section panel-body"><p class="eyebrow">Staging rules</p><ul class="inventory-notes">${notes}</ul></section>`}
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function renderProjects(
  projects: readonly CollectionProjectSummary[],
  templates: readonly CollectionProjectTemplate[],
  hosted: boolean,
): string {
  const rows = projects
    .map(
      (project) => `<tr>
        <td><a class="table-link" href="/projects/${escapeAttribute(project.id)}"><strong>${escapeHtml(project.name)}</strong></a><span>${escapeHtml(project.stateCode ?? 'National')} · ${escapeHtml(project.sectorCodes.map(label).join(', '))}</span></td>
        <td><span class="project-status ${escapeHtml(project.status)}">${escapeHtml(label(project.status))}</span></td>
        <td>${project.organizationsSelected.toLocaleString()}</td>
        <td>${project.sourceRecordsSelected.toLocaleString()}<span>${project.sourceRecordsHeld.toLocaleString()} held</span></td>
        <td>${project.directoriesReady.toLocaleString()}</td>
        <td>${project.recordsCollected.toLocaleString()}<span><a href="/projects/${escapeAttribute(project.id)}/contacts">View contacts</a></span></td>
        <td>${project.queuedJobs + project.runningJobs}</td>
        <td>${project.policyHolds + project.failedJobs}</td>
      </tr>`,
    )
    .join('');
  return page(
    'Collection projects',
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading">
        <div><p class="eyebrow">Collection control plane</p><h1>Collection projects</h1><p class="muted">Choose a governed scope, prepare targets, and release only finite approved batches.</p></div>
        <a class="primary-link" href="/collections/new">Collect by state</a><a class="primary-link${templates.length === 0 ? ' disabled' : ''}" href="/projects/new">Create project</a>
      </section>
      <section class="notice"><span class="shield">✓</span><div><strong>Preparation is separate from collection</strong><p>Creating a project or target does not contact a website. A worker can claim only an explicitly approved batch whose source policy allows it.</p></div></section>
      <section class="panel">
        <div class="panel-heading"><div><p class="eyebrow">Portfolio</p><h2>Configured work</h2></div><span class="summary-chip">${projects.length} project${projects.length === 1 ? '' : 's'}</span></div>
        <div class="table-scroll"><table><thead><tr><th>Scope</th><th>Status</th><th>Organizations</th><th>Source selections</th><th>Directories ready</th><th>Records</th><th>Open jobs</th><th>Holds / failures</th></tr></thead><tbody>${rows.length > 0 ? rows : '<tr><td class="empty" colspan="8">No collection projects yet. Create one from a reviewed jurisdiction configuration.</td></tr>'}</tbody></table></div>
      </section>
      ${templates.length === 0 ? '<section class="warning-card"><strong>No jurisdiction configurations are registered.</strong><p>Add a configuration before creating a collection project.</p></section>' : ''}
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function renderExports(
  purposes: readonly ExportPurpose[],
  projects: readonly CollectionProjectSummary[],
  message: string,
  hosted: boolean,
  selectedProjectId = '',
): string {
  const purposeOptions = purposes
    .map(
      (purpose) =>
        `<option value="${escapeAttribute(purpose.code)}">${escapeHtml(purpose.code)} · ${escapeHtml(purpose.description)}</option>`,
    )
    .join('');
  const projectOptions = projects
    .filter((project) => project.status !== 'cancelled')
    .map(
      (project) =>
        `<option value="${escapeAttribute(project.id)}" ${project.id === selectedProjectId ? 'selected' : ''}>${escapeHtml(project.name)} · ${project.recordsCollected.toLocaleString()} records</option>`,
    )
    .join('');
  const purposeRows = purposes
    .map(
      (purpose) => `<tr>
        <td><strong>${escapeHtml(purpose.code)}</strong><span>${escapeHtml(purpose.description)}</span></td>
        <td>${escapeHtml(purpose.owner)}</td>
        <td>${escapeHtml(purpose.approvedBy)}<span>${formatDate(purpose.approvedAt)}</span></td>
      </tr>`,
    )
    .join('');
  const canExport = purposes.length > 0 && projectOptions.length > 0;

  return page(
    'Exports',
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading"><div><p class="eyebrow">Suppression-safe delivery</p><h1>Export collected records</h1><p class="muted">Download public professional records from one collection project. Every export is filtered in SQL, checked again in memory, checksummed, and audited.</p></div></section>
      ${message.length === 0 ? '' : `<div class="flash" role="status">${escapeHtml(message)}</div>`}
      <div class="project-grid">
        <section class="panel action-panel"><div class="panel-heading"><div><p class="eyebrow">Approval</p><h2>Approve an export purpose</h2></div></div><form class="panel-body release-form" method="post" action="/export-purposes"><label for="purposeCode">Purpose code</label><input id="purposeCode" name="code" pattern="[a-z][a-z0-9_-]{1,63}" placeholder="internal-review" required><label for="purposeDescription">Specific permitted use</label><textarea id="purposeDescription" name="description" rows="3" minlength="8" required placeholder="Internal review of the selected collection pilot"></textarea><label class="check-label"><input type="checkbox" name="approvalConfirmed" value="yes" required><span>I approve this named use of exported records.</span></label><button type="submit">Approve export purpose</button></form></section>
        <section class="panel action-panel"><div class="panel-heading"><div><p class="eyebrow">Download</p><h2>Create a governed CSV</h2></div></div><form class="panel-body release-form" method="post" action="/exports/download"><label class="check-label"><input type="checkbox" name="downloadAll" value="yes" checked><span>Download the complete collection, including all pages</span></label><label for="exportProject">Collection project</label><select id="exportProject" name="projectId" required><option value="">Choose a project</option>${projectOptions}</select><label for="exportPurpose">Approved purpose</label><select id="exportPurpose" name="purpose" required><option value="">Choose an approved purpose</option>${purposeOptions}</select><label for="exportLimit">Maximum rows</label><input id="exportLimit" name="limit" type="number" min="1" max="50000" value="50000" required><label class="check-label"><input type="checkbox" name="includeGeneralInboxes" value="yes"><span>Include published general office inboxes.</span></label><label class="check-label"><input type="checkbox" name="exportConfirmed" value="yes" required><span>I approve this exact export for the selected purpose.</span></label><button type="submit" ${canExport ? '' : 'disabled'}>Download suppression-checked CSV</button><p class="field-help">Inferred candidates remain separate from published addresses. This repository does not send email.</p></form></section>
      </div>
      <section class="panel project-section"><div class="panel-heading"><div><p class="eyebrow">Controlled uses</p><h2>Active export purposes</h2></div><span class="summary-chip">${purposes.length}</span></div><div class="table-scroll"><table><thead><tr><th>Purpose</th><th>Owner</th><th>Approval</th></tr></thead><tbody>${purposeRows.length > 0 ? purposeRows : '<tr><td class="empty" colspan="3">No export purpose has been approved.</td></tr>'}</tbody></table></div></section>
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function renderSourcePolicies(
  policies: readonly SourcePolicyRecord[],
  message: string,
  prefill: { domain: string; sourceTypeCode: string; returnTo: string },
  hosted: boolean,
): string {
  const rows = policies
    .map((policy) => {
      const approved = policy.productionApprovedAt !== null;
      const prohibited = policy.collectionStatus === 'prohibited';
      return `<tr>
        <td><strong>${escapeHtml(policy.domain ?? policy.urlPattern ?? 'Scoped policy')}</strong><span>${escapeHtml(policy.policyUrl ?? 'No policy URL recorded')}</span></td>
        <td><span class="project-status ${escapeHtml(policy.collectionStatus)}">${escapeHtml(label(policy.collectionStatus))}</span></td>
        <td>${escapeHtml(label(policy.automatedAccessStatus))}</td>
        <td>${policy.lastReviewedAt === null ? 'Not reviewed' : `${escapeHtml(policy.reviewedBy ?? 'Unknown')}<span>${formatDate(policy.lastReviewedAt)}</span>`}</td>
        <td>${approved ? `${escapeHtml(policy.productionApprovedBy ?? 'Unknown')}<span>${formatDate(policy.productionApprovedAt ?? '')}</span>` : prohibited ? 'Cannot approve' : `<form class="inline-approval" method="post" action="/policies/${escapeAttribute(policy.id)}/approve"><input type="hidden" name="returnTo" value="${escapeAttribute(prefill.returnTo)}"><input name="approvalNote" aria-label="Approval note" placeholder="Why this source may run" required minlength="8"><label class="check-label"><input type="checkbox" name="approvalConfirmed" value="yes" required><span>I approve production collection</span></label><button class="secondary-button" type="submit">Approve</button></form>`}</td>
      </tr>`;
    })
    .join('');
  return page(
    'Source policies',
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading"><div><p class="eyebrow">Collection gate</p><h1>Source policies</h1><p class="muted">Record what a person actually reviewed. Prohibited sources can never be approved.</p></div></section>
      ${message.length === 0 ? '' : `<div class="flash">${escapeHtml(message)}</div>`}
      ${prefill.returnTo === '/policies' ? '' : `<p><a class="secondary-link" href="${escapeAttribute(prefill.returnTo)}">Back to held batch</a></p>`}
      <section class="panel project-form">
        <div class="panel-heading"><div><p class="eyebrow">Human review</p><h2>Record a source decision</h2></div></div>
        <form method="post" action="/policies">
          <input type="hidden" name="returnTo" value="${escapeAttribute(prefill.returnTo)}">
          <div class="form-section"><div class="form-grid">
            <div><label for="domain">Domain</label><input id="domain" name="domain" value="${escapeAttribute(prefill.domain)}" placeholder="agency.gov"></div>
            <div><label for="urlPattern">URL pattern (optional)</label><input id="urlPattern" name="urlPattern" placeholder="^https://agency\\.gov/directory/"></div>
            <div><label for="sourceTypeCode">Source type</label><input id="sourceTypeCode" name="sourceTypeCode" value="${escapeAttribute(prefill.sourceTypeCode)}" placeholder="html_directory"></div>
            <div><label for="policyUrl">Policy or terms URL</label><input id="policyUrl" name="policyUrl" type="url" placeholder="https://agency.gov/terms"></div>
          </div><div class="form-grid three-columns">
            ${policySelect('collectionStatus', 'Collection status', ['unknown', 'review_required', 'permitted', 'prohibited'])}
            ${policySelect('automatedAccessStatus', 'Automated access', ['unknown', 'restricted', 'permitted', 'prohibited'])}
            ${policySelect('commercialUseStatus', 'Commercial use', ['unknown', 'restricted', 'permitted', 'prohibited'])}
            ${policySelect('solicitationStatus', 'Solicitation', ['unknown', 'restricted', 'permitted', 'prohibited'])}
          </div>
          <label for="policyTextSnapshot">Relevant policy text snapshot</label><textarea id="policyTextSnapshot" name="policyTextSnapshot" rows="5"></textarea>
          <label for="reviewNotes">What you checked</label><textarea id="reviewNotes" name="reviewNotes" rows="3" required minlength="8"></textarea></div>
          <div class="form-actions"><button type="submit">Record review</button></div>
        </form>
      </section>
      <section class="panel project-section"><div class="panel-heading"><div><p class="eyebrow">Audit trail</p><h2>Recorded decisions</h2></div><span class="summary-chip">${policies.length}</span></div><div class="table-scroll"><table><thead><tr><th>Source</th><th>Collection</th><th>Automation</th><th>Reviewed</th><th>Production approval</th></tr></thead><tbody>${rows.length > 0 ? rows : '<tr><td class="empty" colspan="5">No source policies have been reviewed.</td></tr>'}</tbody></table></div></section>
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function policySelect(name: string, title: string, values: readonly string[]): string {
  return `<div><label for="${name}">${escapeHtml(title)}</label><select id="${name}" name="${name}">${values.map((value) => `<option value="${value}">${escapeHtml(label(value))}</option>`).join('')}</select></div>`;
}

function renderNewProject(
  templates: readonly CollectionProjectTemplate[],
  catalog: ProjectBuilderCatalog,
  error = '',
  hosted = false,
): string {
  const options = templates
    .map(
      (template) =>
        `<option value="${escapeAttribute(template.key)}" data-state="${escapeAttribute(template.stateCode ?? 'National')}" data-national="${template.stateCode === null ? 'true' : 'false'}" data-levels="${escapeAttribute(template.governmentLevelCode)}" data-sectors="${escapeAttribute(template.sectorCodes.join(','))}">${escapeHtml(template.name)} · ${escapeHtml(template.stateCode ?? 'National')} · ${escapeHtml(template.sectorCodes.map(label).join(', '))}</option>`,
    )
    .join('');
  const stateNames = new Map((catalog.states ?? []).map((state) => [state.code, state.name]));
  const configuredStates = unique([
    'National',
    ...(catalog.states ?? []).map((state) => state.code),
    ...templates.flatMap((template) => (template.stateCode === null ? [] : [template.stateCode])),
  ])
    .map(
      (state) =>
        `<option value="${escapeAttribute(state)}">${escapeHtml(stateNames.get(state) ?? state)}</option>`,
    )
    .join('');
  const governmentLevels = catalog.governmentLevels
    .map(
      (item) => `<option value="${escapeAttribute(item.code)}">${escapeHtml(item.name)}</option>`,
    )
    .join('');
  const sectors = catalog.sectors
    .map(
      (item) => `<option value="${escapeAttribute(item.code)}">${escapeHtml(item.name)}</option>`,
    )
    .join('');
  const organizationTypes = catalog.organizationTypes
    .map(
      (item) => `<button class="scope-option" type="button" draggable="true"
        data-choice-code="${escapeAttribute(item.code)}"
        data-default-level="${escapeAttribute(item.defaultGovernmentLevelCode ?? '')}"
        data-default-sector="${escapeAttribute(item.defaultSectorCode ?? '')}">
        <strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description)}</small>
      </button>`,
    )
    .join('');
  const hiddenOrganizationTypeOptions = catalog.organizationTypes
    .map(
      (item) => `<option value="${escapeAttribute(item.code)}">${escapeHtml(item.name)}</option>`,
    )
    .join('');
  return page(
    'Create collection project',
    `${appHeader('/projects', hosted)}
    <main class="dashboard project-builder-dashboard">
      <section class="dashboard-heading"><div><p class="eyebrow">National collection planner</p><h1>Build a collection project</h1><p class="muted">Choose from the shared jurisdiction and taxonomy spine. Creating a project prepares scope only; it never contacts a website.</p></div></section>
      ${error.length > 0 ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
      <section class="coverage-spine" aria-label="Coverage spine">
        ${catalog.governmentLevels.map((item) => `<div><strong>${escapeHtml(item.name)}</strong><span>${templates.some((template) => template.governmentLevelCode === item.code) ? 'Configured' : 'Needs a reviewed source configuration'}</span></div>`).join('')}
      </section>
      <form class="panel project-form" method="post" action="/projects" data-project-builder>
        <div class="form-section"><p class="eyebrow">Step 1</p><h2>Choose jurisdiction, location, and work</h2><div class="form-grid three-columns"><label for="template">Configured jurisdiction<select id="template" name="template" required>${options}</select></label><label for="statePreview">State or national scope<select id="statePreview" name="stateCode">${configuredStates}</select></label><label for="levelPreview">Government level<select id="levelPreview" name="governmentLevelCode">${governmentLevels}</select></label><label for="sectorPreview">Sector<select id="sectorPreview" name="sectorCode">${sectors}</select></label><label class="wide-field" for="name">Project name<input id="name" name="name" required placeholder="Public workforce collection"></label></div><p class="scope-resolution" data-scope-status role="status"></p><p class="field-help">Changing any scope menu selects its matching reviewed jurisdiction configuration. If no match exists yet, the project cannot be created until its official sources and mappings are configured. Today only one jurisdiction is executable; the shared model already supports every government level shown above.</p></div>
        <div class="form-section"><p class="eyebrow">Step 2</p><h2>Choose organization types</h2><p class="section-copy">Drag types into the included shelf, or click a type to move it. Leave the shelf empty to include every matching type in the configured scope.</p><div class="choice-builder" data-choice-builder><section class="choice-bin"><h3>Available types</h3><div class="choice-list" data-choice-source>${organizationTypes}</div></section><section class="choice-bin selected-bin" data-choice-target><h3>Included in this project</h3><p class="choice-empty" data-choice-empty>All organization types in scope</p><div class="choice-list" data-choice-selected></div></section><select class="sr-only" name="organizationTypes" multiple data-choice-select aria-label="Included organization types">${hiddenOrganizationTypeOptions}</select></div><details class="advanced-filters"><summary>Advanced organization ID filters</summary><div class="form-grid"><label for="includeOrganizations">Only these organization IDs<textarea id="includeOrganizations" name="includeOrganizations" rows="2" placeholder="Optional comma-separated UUIDs"></textarea></label><label for="excludeOrganizations">Exclude organization IDs<textarea id="excludeOrganizations" name="excludeOrganizations" rows="2" placeholder="Optional comma-separated UUIDs"></textarea></label></div><p class="field-help">IDs stay as optional advanced text inputs because they are exact identifiers, not a practical list to browse at national scale.</p></details></div>
        <div class="form-section"><p class="eyebrow">Step 3</p><h2>Choose workload behavior and safeguards</h2><div class="scale-note"><strong>Targets are public organization websites, not people.</strong><span>A batch of 100 targets may yield thousands of public professional records. The resulting record count is measured, not guessed or capped here.</span></div><fieldset class="work-mode"><legend>Worker behavior</legend><label><input type="radio" name="workMode" value="approved_batch_complete" checked><span><strong>Continue until the approved batch is complete</strong><small>The worker keeps claiming known targets until that finite approved queue is empty.</small></span></label><label><input type="radio" name="workMode" value="operator_job_limit"><span><strong>Stop after an operator-set job count</strong><small>Use this for a short pilot or a supervised diagnostic run.</small></span></label></fieldset><div class="form-grid"><label>Organization websites per approved batch<input name="batchSize" type="number" min="1" max="1000" value="100" required></label><label>Pages per website<input name="maxPagesPerTarget" type="number" min="1" max="1000" value="10" required></label><label>Total pages before safety review<input name="maxPagesPerBatch" type="number" min="1" max="100000" value="1000" required></label><label>Errors before automatic safety stop<input name="maxErrorsPerBatch" type="number" min="1" max="1000" value="10" required></label></div><p class="field-help">Continue-until-complete removes the arbitrary worker stop, not the protections. Each live release still has a known target set, explicit approval, per-site rate limits, source-policy and robots checks, and page/error circuit breakers.</p></div>
        <div class="form-section data-coverage"><p class="eyebrow">Organization profile</p><h2>What the spine can retain</h2><div class="data-coverage-grid"><div><strong>Identity and location</strong><span>Official name, external IDs, jurisdiction, website, office address, city, county, and state.</span></div><div><strong>Sector aggregates</strong><span>Enrollment, service span, organization type, and published status. Never protected individual information.</span></div><div><strong>Workforce progress</strong><span>Directories found, public staff records observed, roles collected, coverage percentage, and remaining organizations.</span></div><div><strong>Estimates kept honest</strong><span>Derived workforce estimates must carry their method, date, confidence, and source separately from observed counts.</span></div></div></div>
        <div class="form-actions"><a class="secondary-link" href="/projects">Cancel</a><button type="submit" data-create-project ${templates.length === 0 ? 'disabled' : ''}>Create draft project</button></div>
      </form>
    </main>${appFooter(hosted)}<script src="/assets/project-builder.js" defer></script>`,
    'dashboard-page',
  );
}

function renderProjectDetail(
  project: CollectionProjectSummary,
  batches: readonly CollectionBatchSummary[],
  policyHolds: readonly CollectionPolicyHold[],
  template: CollectionProjectTemplate | undefined,
  message: string,
  hosted: boolean,
): string {
  const sourceRows = (template?.officialSources ?? [])
    .map(
      (source) =>
        `<tr><td><strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(source.provides)}</span></td><td><span class="project-status ${source.verified ? 'active' : 'paused'}">${source.verified ? 'Verified' : 'Unverified'}</span></td><td>${escapeHtml(source.verificationNote)}</td></tr>`,
    )
    .join('');
  const batchRows = batches
    .map(
      (batch) =>
        `<tr><td>#${batch.sequenceNumber}</td><td>${escapeHtml(label(batch.kind))}</td><td><span class="project-status ${escapeHtml(batch.status)}">${escapeHtml(label(batch.status))}</span></td><td>${batch.completedJobs} complete · ${batch.queuedJobs} open</td><td>${batch.pagesProcessed} / ${batch.pageLimit}</td><td>${batch.heldJobs > 0 ? `<a class="table-link" href="#policy-holds">${batch.heldJobs} policy ${batch.heldJobs === 1 ? 'hold' : 'holds'}</a>` : `${batch.failedJobs} / ${batch.errorLimit}`}</td><td>${batch.approvedBy === null ? 'Not approved' : `${escapeHtml(batch.approvedBy)}<span>${formatDate(batch.approvedAt ?? batch.createdAt)}</span>`}</td></tr>`,
    )
    .join('');
  const policyHoldRows = policyHolds
    .map((hold) => {
      const reviewUrl = `/policies?domain=${encodeURIComponent(hold.domain)}&sourceTypeCode=${encodeURIComponent(hold.sourceTypeCode)}&returnTo=${encodeURIComponent(`/projects/${project.id}`)}`;
      return `<tr><td><strong>${escapeHtml(hold.domain)}</strong><span>${escapeHtml(hold.organizationName)}${hold.jobCount > 1 ? ` · ${hold.jobCount} held jobs` : ''}</span></td><td>${escapeHtml(hold.reason)}</td><td><a class="table-link" href="${escapeAttribute(hold.targetUrl)}" target="_blank" rel="noopener noreferrer">Inspect source</a></td><td><a class="secondary-link" href="${escapeAttribute(reviewUrl)}">Record policy review</a></td></tr>`;
    })
    .join('');
  const canRelease = project.status !== 'completed' && project.status !== 'cancelled';
  return page(
    project.name,
    `${appHeader('/projects', hosted)}
    <main class="dashboard">
      <section class="dashboard-heading"><div><p class="eyebrow">${escapeHtml(project.stateCode ?? 'National')} · ${escapeHtml(project.sectorCodes.map(label).join(', '))}</p><h1>${escapeHtml(project.name)}</h1><p class="muted">${project.estimatedOrganizationCount === null ? 'No published nationwide estimate has been recorded. The selected count below is actual database membership.' : `${project.estimatedOrganizationCount.toLocaleString()} organizations estimated from a published source.`}</p></div><span class="project-status large ${escapeHtml(project.status)}">${escapeHtml(label(project.status))}</span></section>
      ${message.length > 0 ? `<div class="flash" role="status">${escapeHtml(message)}</div>` : ''}
      <section class="metrics project-metrics">
        ${metric('Selected organizations', project.organizationsSelected, `${project.websitesAvailable} with a published website`)}
        ${metric('Source records selected', project.sourceRecordsSelected, `${project.sourceRecordsReady} ready · ${project.sourceRecordsHeld} awaiting classification`)}
        ${metric('Directories ready', project.directoriesReady, 'Discovered and awaiting a crawl batch')}
        ${metric('Records extracted', project.recordsCollected, 'Includes repeat observations; open View contacts for stored results')}
      </section>
      <div class="button-row"><a class="primary-link" href="/projects/${escapeAttribute(project.id)}/contacts">View contacts</a><a class="secondary-link" href="/exports?projectId=${escapeAttribute(project.id)}">Download CSV</a></div>
      <div class="project-grid">
        <section class="panel action-panel"><div class="panel-heading"><div><p class="eyebrow">Prepare</p><h2>Scope and targets</h2></div></div><div class="panel-body"><p>Refresh membership from the current database filters, then create discovery targets only from website URLs that sources actually published.</p><div class="button-row"><form method="post" action="/projects/${escapeAttribute(project.id)}/refresh"><button class="secondary-button" type="submit">Refresh organizations</button></form><form method="post" action="/projects/${escapeAttribute(project.id)}/generate"><button class="secondary-button" type="submit">Generate discovery work</button></form></div><dl class="limits"><div><dt>Organization types</dt><dd>${project.filters.organizationTypeCodes.length === 0 ? 'All in scope' : escapeHtml(project.filters.organizationTypeCodes.join(', '))}</dd></div><div><dt>Worker behavior</dt><dd>${project.filters.workMode === 'approved_batch_complete' ? 'Continue until approved batch is complete' : 'Stop at operator job count'}</dd></div><div><dt>Batch safety cap</dt><dd>${project.batchSize} targets</dd></div><div><dt>Per-target safety cap</dt><dd>${project.maxPagesPerTarget} pages</dd></div><div><dt>Batch circuit breaker</dt><dd>${project.maxPagesPerBatch} pages or ${project.maxErrorsPerBatch} errors</dd></div></dl></div></section>
        <section class="panel action-panel"><div class="panel-heading"><div><p class="eyebrow">Release</p><h2>Approve one finite batch</h2></div></div><form class="panel-body release-form" method="post" action="/projects/${escapeAttribute(project.id)}/batch"><label for="kind">Work stage</label><select id="kind" name="kind"><option value="discovery">Discover directories</option><option value="crawl">Collect directory records</option></select><label for="targetLimit">Maximum targets in this release</label><input id="targetLimit" name="targetLimit" type="number" min="1" max="${project.batchSize}" value="${Math.min(10, project.batchSize)}" required><label for="approvalNote">Specific approval note</label><textarea id="approvalNote" name="approvalNote" rows="3" required placeholder="Approve a pilot of up to 10 reviewed targets"></textarea><label class="check-label"><input type="checkbox" name="approvalConfirmed" value="yes" required><span>I approve this exact batch. This approval does not carry over to another batch.</span></label><button type="submit" ${canRelease ? '' : 'disabled'}>Approve and queue batch</button><p class="field-help">The scheduler still checks source policy and robots before every request. A policy hold is never retried harder.</p></form></section>
      </div>
      <section class="panel project-section"><div class="panel-heading"><div><p class="eyebrow">Readiness</p><h2>Official sources</h2></div><span class="summary-chip">${(template?.officialSources ?? []).filter((source) => source.verified).length} verified</span></div><div class="table-scroll"><table><thead><tr><th>Source</th><th>Verification</th><th>What remains</th></tr></thead><tbody>${sourceRows.length > 0 ? sourceRows : '<tr><td class="empty" colspan="3">The configuration is not available in this running console.</td></tr>'}</tbody></table></div></section>
      <section class="panel project-section"><div class="panel-heading"><div><p class="eyebrow">Durable queue</p><h2>Approved batches</h2></div></div><div class="table-scroll"><table><thead><tr><th>Batch</th><th>Stage</th><th>Status</th><th>Jobs</th><th>Pages</th><th>Issues</th><th>Approval</th></tr></thead><tbody>${batchRows.length > 0 ? batchRows : '<tr><td class="empty" colspan="7">No work has been released. Preparation alone never starts collection.</td></tr>'}</tbody></table></div></section>
      ${policyHolds.length === 0 ? '' : `<section id="policy-holds" class="panel project-section"><div class="panel-heading"><div><p class="eyebrow">Action required</p><h2>Review held source domains</h2><p class="muted">No request was made to these sources. Inspect each source, record its policy decision, then approve a new finite batch. The failed batch will not retry itself.</p></div><span class="summary-chip">${policyHolds.length}</span></div><div class="table-scroll"><table><thead><tr><th>Domain</th><th>Hold reason</th><th>Source</th><th>Next action</th></tr></thead><tbody>${policyHoldRows}</tbody></table></div></section>`}
      <section class="project-controls"><a class="secondary-link" href="/projects/${escapeAttribute(project.id)}/outcomes">Coverage and exceptions</a><a class="primary-link" href="/projects/${escapeAttribute(project.id)}/run">Start full collection</a><form method="post" action="/projects/${escapeAttribute(project.id)}/status"><input type="hidden" name="status" value="${project.status === 'paused' ? 'active' : 'paused'}"><button class="secondary-button" type="submit">${project.status === 'paused' ? 'Resume approved work' : 'Pause project'}</button></form><form method="post" action="/projects/${escapeAttribute(project.id)}/status"><input type="hidden" name="status" value="completed"><button class="quiet-button" type="submit">Mark complete</button></form></section>
    </main>${appFooter(hosted)}`,
    'dashboard-page',
  );
}

function policyReturnPath(value: string | null): string {
  return value !== null && /^\/projects\/[0-9a-f-]+$/.test(value) ? value : '/policies';
}

function appHeader(backTo: string, hosted: boolean): string {
  return `<header class="topbar"><a class="wordmark" href="/" aria-label="Public Workforce Data home"><span class="brand-mark small">PW</span><span>Public Workforce Data<small>Operator console</small></span></a><div class="topbar-actions"><a class="nav-link" href="/spine">Organization spine</a><a class="nav-link" href="/organization-records">Explore organizations</a><a class="nav-link" href="${escapeAttribute(backTo)}">Collection projects</a><a class="nav-link" href="/policies">Source policies</a><a class="nav-link" href="/exports">Exports</a><span class="local-badge"><span class="status-dot"></span>${hosted ? 'Hosted service' : 'Local workspace'}</span><form method="post" action="/logout"><button class="quiet-button" type="submit">Sign out</button></form></div></header>`;
}

function appFooter(hosted: boolean): string {
  return `<footer><span>${hosted ? 'Hosted' : 'Local'} review surface</span><span>Public professional data only</span></footer>`;
}

function metric(title: string, value: number, detail: string): string {
  return `<article class="metric-card"><p>${escapeHtml(title)}</p><strong>${value.toLocaleString()}</strong><span>${escapeHtml(detail)}</span></article>`;
}

function pipelineStage(number: string, title: string, detail: string, complete: boolean): string {
  return `<article class="pipeline-stage${complete ? ' complete' : ''}"><span>${escapeHtml(number)}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div></article>`;
}

function filterSelect(
  name: string,
  title: string,
  selectedValue: string,
  options: readonly { code: string; name: string }[],
): string {
  return `<label>${escapeHtml(title)}<select name="${escapeAttribute(name)}"><option value="">All</option>${options.map((option) => `<option value="${escapeAttribute(option.code)}"${option.code === selectedValue ? ' selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select></label>`;
}

function spineFilters(
  url: URL,
  catalog: ProjectBuilderCatalog,
  inventory: OrganizationSpineInventory | undefined,
): SpineFilters {
  return {
    governmentLevelCode: allowedSelection(
      url.searchParams.get('governmentLevelCode'),
      catalog.governmentLevels,
    ),
    sectorCode: allowedSelection(url.searchParams.get('sectorCode'), catalog.sectors),
    stateCode: allowedSelection(url.searchParams.get('stateCode'), inventory?.states ?? []),
    organizationTypeCode: allowedSelection(
      url.searchParams.get('organizationTypeCode'),
      catalog.organizationTypes,
    ),
  };
}

function allowedSelection(value: string | null, options: readonly { code: string }[]): string {
  return value !== null && options.some((option) => option.code === value) ? value : '';
}

function selected(value: string): string[] {
  return value.length === 0 ? [] : [value];
}

function explorerPreset(
  requestedKey: string | null,
  catalog: ProjectBuilderCatalog,
): OrganizationExplorerPreset | null {
  return (
    catalog.explorerPresets.find((preset) => preset.key === requestedKey) ??
    catalog.explorerPresets[0] ??
    null
  );
}

function matchingExplorerPreset(
  record: OrganizationSourceRecord,
  catalog: ProjectBuilderCatalog,
): OrganizationExplorerPreset | null {
  return (
    catalog.explorerPresets.find(
      (preset) =>
        record.organizationTypeCode !== null &&
        preset.organizationTypeCodes.includes(record.organizationTypeCode) &&
        record.sectorCode !== null &&
        preset.sectorCodes.includes(record.sectorCode),
    ) ?? null
  );
}

function knownStateCode(value: string | null, catalog: ProjectBuilderCatalog): string | null {
  return value !== null && (catalog.states ?? []).some((state) => state.code === value)
    ? value
    : null;
}

function websiteFilter(value: string | null): 'all' | 'published' | 'missing' {
  return value === 'published' || value === 'missing' ? value : 'all';
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectableProjectOptions(projects: readonly CollectionProjectSummary[]): string {
  return projects
    .filter((project) => project.status !== 'completed' && project.status !== 'cancelled')
    .map(
      (project) =>
        `<option value="${escapeAttribute(project.id)}">${escapeHtml(project.name)} · ${escapeHtml(project.stateCode ?? 'National')}</option>`,
    )
    .join('');
}

function explorerUrl(presetKey: string, filters: OrganizationRecordViewFilters): string {
  const params = new URLSearchParams({ preset: presetKey });
  if (filters.query.trim().length > 0) params.set('q', filters.query.trim());
  if (filters.stateCode.length > 0) params.set('stateCode', filters.stateCode);
  if (filters.websiteAvailability !== 'all') params.set('website', filters.websiteAvailability);
  if (filters.page > 1) params.set('page', String(filters.page));
  return `/organization-records?${params.toString()}`;
}

function safeExplorerReturnPath(value: string | null, presetKey: string): string {
  if (value !== null && /^\/organization-records(?:\/[0-9a-f-]+)?(?:\?[^#]*)?$/.test(value)) {
    return value;
  }
  return `/organization-records?preset=${encodeURIComponent(presetKey)}`;
}

function formatExplorerValue(value: unknown, format: 'integer' | 'decimal' | 'text'): string {
  if (value === null || value === undefined || value === '') return 'Not published';
  if (format === 'integer' && typeof value === 'number') return Math.round(value).toLocaleString();
  if (format === 'decimal' && typeof value === 'number') {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return primitiveText(value, 'Not published');
}

function primitiveText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value) ?? fallback;
  return fallback;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized : 'collection-project';
}

function commaList(value: string | null): string[] {
  return value === null
    ? []
    : [
        ...new Set(
          value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        ),
      ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formInteger(form: URLSearchParams, key: string, fallback: number): number {
  const raw = form.get(key);
  if (raw === null || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${label(key)} must be a whole number`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function renderMessage(title: string, detail: string): string {
  return page(
    title,
    `<main class="message-shell"><div class="login-card"><div class="brand-mark">PW</div><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(detail)}</p><a class="button-link" href="/">Open console</a></div></main>`,
  );
}

function page(title: string, body: string, bodyClass = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} | Public Workforce Data</title><style>${STYLES}</style></head><body class="${escapeAttribute(bodyClass)}">${body}</body></html>`;
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value: string): string {
  return escapeHtml(
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value)),
  );
}

function timeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

const STYLES = `
:root{--ink:#172c35;--muted:#627279;--paper:#f4f1e9;--panel:#fffefa;--line:#dcd9cf;--teal:#176b68;--teal-soft:#d8ebe5;--gold:#cf8e32;--shadow:0 18px 45px rgba(23,44,53,.09);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--paper)}button,input,select,textarea{font:inherit}button,.button-link{cursor:pointer}.eyebrow{margin:0 0 10px;color:var(--teal);font-size:.72rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.muted{color:var(--muted);line-height:1.6}.brand-mark{display:grid;width:52px;height:52px;place-items:center;border-radius:14px;background:var(--teal);color:white;font-family:ui-serif,serif;font-weight:700;letter-spacing:.03em}.brand-mark.small{width:38px;height:38px;border-radius:10px;font-size:.82rem}.status-dot{width:8px;height:8px;border-radius:50%;background:#59a686;box-shadow:0 0 0 4px rgba(89,166,134,.13)}
.login-shell{display:grid;min-height:100vh;grid-template-columns:minmax(380px,1fr) minmax(440px,1fr)}.login-brand{display:flex;flex-direction:column;justify-content:center;padding:clamp(48px,8vw,120px);background:var(--ink);color:white;position:relative;overflow:hidden}.login-brand:after{content:"";position:absolute;width:420px;height:420px;right:-190px;bottom:-180px;border:1px solid rgba(255,255,255,.14);border-radius:50%;box-shadow:0 0 0 68px rgba(255,255,255,.035),0 0 0 136px rgba(255,255,255,.025)}.login-brand .eyebrow{margin-top:42px;color:#9dcfc1}.login-brand h1{max-width:600px;margin:0;font-family:ui-serif,serif;font-size:clamp(3rem,6vw,5.7rem);font-weight:500;line-height:.96;letter-spacing:-.045em}.brand-copy{max-width:520px;margin:28px 0;color:#c6d1d2;font-size:1.08rem;line-height:1.7}.boundary-note{display:flex;align-items:center;gap:12px;margin-top:42px;color:#d7e1df;font-size:.9rem}.login-panel{display:grid;place-items:center;padding:48px;background:radial-gradient(circle at 85% 10%,#e5eee8 0,transparent 32%),var(--paper)}.login-card{width:min(100%,450px);padding:46px;border:1px solid var(--line);border-radius:22px;background:rgba(255,254,250,.94);box-shadow:var(--shadow)}.login-card h2{margin:0;font-family:ui-serif,serif;font-size:2.4rem;font-weight:500;letter-spacing:-.025em}.login-card form{display:grid;gap:10px;margin-top:30px}.login-card label{margin-top:8px;font-size:.82rem;font-weight:750}.login-card input,.search input{width:100%;border:1px solid #b9c1bc;border-radius:10px;background:white;color:var(--ink);outline:none}.login-card input{height:50px;padding:0 14px}.login-card input:focus,.search input:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(23,107,104,.12)}.login-card button,.button-link{display:grid;height:50px;margin-top:14px;place-items:center;border:0;border-radius:10px;background:var(--teal);color:white;font-weight:750;text-decoration:none}.login-card button:hover,.button-link:hover{background:#105956}.fine-print{margin:24px 0 0;color:#7a8589;font-size:.78rem;line-height:1.55}.error{margin:20px 0 0;padding:12px 14px;border:1px solid #ddb1a9;border-radius:9px;background:#fbebe7;color:#8f3528;font-size:.88rem}
.topbar{display:flex;height:76px;align-items:center;justify-content:space-between;padding:0 clamp(24px,5vw,72px);border-bottom:1px solid var(--line);background:rgba(255,254,250,.92)}.wordmark{display:flex;align-items:center;gap:12px;color:var(--ink);font-family:ui-serif,serif;font-size:1.02rem;font-weight:700;text-decoration:none}.wordmark small{display:block;margin-top:2px;color:var(--muted);font-family:Inter,sans-serif;font-size:.66rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.topbar-actions{display:flex;align-items:center;gap:18px}.local-badge{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.82rem}.quiet-button{border:1px solid var(--line);border-radius:8px;padding:9px 14px;background:transparent;color:var(--ink);font-size:.82rem;font-weight:700}.quiet-button:hover{background:#eeece5}.dashboard{width:min(1480px,calc(100% - 48px));margin:0 auto;padding:52px 0 68px}.dashboard-heading{display:flex;align-items:end;justify-content:space-between;gap:32px;margin-bottom:28px}.dashboard-heading h1{margin:0;font-family:ui-serif,serif;font-size:clamp(2.5rem,5vw,4.4rem);font-weight:500;letter-spacing:-.045em}.dashboard-heading .muted{margin:12px 0 0}.freshness{min-width:200px;padding-left:20px;border-left:2px solid var(--gold)}.freshness span{display:block;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}.freshness strong{display:block;margin-top:7px;font-family:ui-serif,serif;font-size:1.02rem}.notice{display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:16px 20px;border:1px solid #b8d8ce;border-radius:12px;background:var(--teal-soft)}.notice .shield{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:var(--teal);color:white;font-weight:900}.notice p{margin:3px 0 0;color:#456760;font-size:.84rem}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}.metric-card,.panel{border:1px solid var(--line);background:var(--panel);box-shadow:0 8px 24px rgba(23,44,53,.04)}.metric-card{padding:24px;border-radius:14px}.metric-card p{margin:0;color:var(--muted);font-size:.8rem;font-weight:700}.metric-card strong{display:block;margin:10px 0 7px;font-family:ui-serif,serif;font-size:2.5rem;font-weight:500}.metric-card span{color:#7a8589;font-size:.76rem}.content-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(240px,1fr);gap:20px}.panel{border-radius:14px;overflow:hidden}.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 26px;border-bottom:1px solid var(--line)}.panel-heading .eyebrow{margin-bottom:5px}.panel h2{margin:0;font-family:ui-serif,serif;font-size:1.6rem;font-weight:500}.search{display:flex;width:min(430px,50%)}.search input{height:40px;padding:0 12px;border-radius:8px 0 0 8px}.search button{border:0;border-radius:0 8px 8px 0;padding:0 16px;background:var(--ink);color:white;font-size:.78rem;font-weight:750}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th{padding:13px 18px;border-bottom:1px solid var(--line);background:#f0eee7;color:#66757a;font-size:.69rem;letter-spacing:.06em;text-transform:uppercase}td{padding:17px 18px;border-bottom:1px solid #e8e5dd;color:#43565d;font-size:.82rem;vertical-align:middle}tbody tr:last-child td{border-bottom:0}td strong{display:block;color:var(--ink);font-size:.86rem}td span:not(.pill):not(.run-status){display:block;margin-top:4px;color:#788489;font-size:.76rem}.pill{display:inline-block;padding:5px 8px;border-radius:20px;background:#edf1ed;color:#53645f;font-size:.68rem;font-weight:750;white-space:nowrap}.confidence{display:inline-block;width:54px;height:5px;margin-right:8px;border-radius:10px;background:#e0e3df;overflow:hidden;vertical-align:middle}.confidence span{display:block;height:100%;background:var(--teal)}td small{color:var(--muted)}.table-note{margin:0;padding:14px 20px;border-top:1px solid var(--line);background:#faf9f4;color:#738085;font-size:.73rem}.empty{padding:32px!important;color:var(--muted);text-align:center}.breakdown{margin:0;padding:8px 24px 18px;list-style:none}.breakdown li{display:flex;align-items:center;justify-content:space-between;padding:17px 2px;border-bottom:1px solid #e8e5dd;color:var(--ink);font-size:.84rem}.breakdown li:last-child{border:0}.breakdown small{display:block;margin-top:4px;color:var(--muted);font-size:.7rem;font-weight:500}.breakdown strong{font-family:ui-serif,serif;font-size:1.3rem}.runs-panel{margin-top:20px}.summary-chip{padding:7px 10px;border-radius:20px;background:var(--teal-soft);color:#2f655d;font-size:.72rem;font-weight:750}.run-status{display:inline-block;width:8px;height:8px;margin-right:9px;border-radius:50%;background:#879398}.run-status.completed{background:#59a686}.run-status.failed{background:#b95746}footer{display:flex;justify-content:space-between;padding:24px clamp(24px,5vw,72px);border-top:1px solid var(--line);color:#7c878a;font-size:.72rem}.message-shell{display:grid;min-height:100vh;place-items:center;padding:30px}.message-shell h1{font-family:ui-serif,serif;font-weight:500}.button-link{margin-top:25px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.nav-link,.table-link{color:var(--teal);font-size:.82rem;font-weight:750;text-decoration:none}.table-link strong{color:var(--teal)}.primary-link,.secondary-link{display:inline-flex;align-items:center;justify-content:center;border-radius:9px;padding:12px 17px;font-size:.82rem;font-weight:750;text-decoration:none}.primary-link{background:var(--teal);color:white}.primary-link.disabled{opacity:.45;pointer-events:none}.secondary-link{border:1px solid var(--line);color:var(--ink)}.narrow-dashboard{max-width:980px}.project-builder-dashboard{max-width:1180px}.project-form{overflow:visible}.form-section{padding:28px;border-bottom:1px solid var(--line)}.form-section h2{margin:0 0 18px}.section-copy{margin:-8px 0 20px;color:var(--muted);font-size:.82rem;line-height:1.55}.project-form label,.release-form label{display:block;margin:16px 0 7px;font-size:.8rem;font-weight:750}.project-form input,.project-form select,.project-form textarea,.release-form input,.release-form select,.release-form textarea{width:100%;border:1px solid #b9c1bc;border-radius:9px;padding:11px 13px;background:white;color:var(--ink)}.project-form select:disabled{background:#f2f1ec;color:#52636a;opacity:1}.field-help{margin:10px 0 0;color:var(--muted);font-size:.75rem;line-height:1.5}.scope-resolution{min-height:20px;margin:12px 0 0;color:var(--teal);font-size:.78rem;font-weight:750}.scope-resolution.unavailable{color:#8f3d31}.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 18px}.form-grid.three-columns{grid-template-columns:repeat(3,1fr)}.wide-field{grid-column:span 2}.form-actions{display:flex;justify-content:flex-end;gap:12px;padding:22px 28px}.form-actions button,.release-form button{border:0;border-radius:9px;padding:12px 17px;background:var(--teal);color:white;font-weight:750}.form-actions button:disabled,.release-form button:disabled{opacity:.45}.coverage-spine{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}.coverage-spine div{min-height:84px;padding:16px;border:1px solid var(--line);border-radius:11px;background:#fffefa}.coverage-spine strong,.coverage-spine span{display:block}.coverage-spine strong{font-size:.82rem}.coverage-spine span{margin-top:7px;color:var(--muted);font-size:.67rem;line-height:1.4}.choice-builder{display:grid;grid-template-columns:1fr 1fr;gap:16px}.choice-bin{min-height:250px;padding:17px;border:1px dashed #aebbb6;border-radius:12px;background:#f8f7f2}.choice-bin.drag-over{border-color:var(--teal);background:var(--teal-soft)}.choice-bin h3{margin:0 0 13px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}.choice-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.scope-option{padding:12px;border:1px solid var(--line);border-radius:9px;background:white;color:var(--ink);text-align:left}.scope-option:hover,.scope-option:focus{border-color:var(--teal);box-shadow:0 0 0 2px rgba(23,107,104,.1)}.scope-option strong,.scope-option small{display:block}.scope-option strong{font-size:.77rem}.scope-option small{margin-top:5px;color:var(--muted);font-size:.65rem;line-height:1.35}.scope-option[hidden]{display:none}.selected-bin .scope-option{border-color:#a8cfc3;background:#eef8f4}.choice-empty{margin:45px auto;color:var(--muted);font-size:.8rem;text-align:center}.advanced-filters{margin-top:20px;border-top:1px solid var(--line);padding-top:17px}.advanced-filters summary{cursor:pointer;color:var(--teal);font-size:.8rem;font-weight:750}.scale-note{display:flex;align-items:flex-start;gap:16px;margin-bottom:16px;padding:16px;border-left:3px solid var(--gold);background:#faf4e7}.scale-note strong{min-width:240px;font-size:.82rem}.scale-note span{color:var(--muted);font-size:.78rem;line-height:1.5}.work-mode{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 18px;padding:0;border:0}.work-mode legend{margin-bottom:8px;font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.work-mode label{display:flex;gap:10px;margin:0;padding:15px;border:1px solid var(--line);border-radius:10px;background:#f8f7f2}.work-mode input{width:auto;margin:2px 0 0}.work-mode span,.work-mode strong,.work-mode small{display:block}.work-mode strong{font-size:.79rem}.work-mode small{margin-top:5px;color:var(--muted);font-size:.68rem;line-height:1.4}.data-coverage-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.data-coverage-grid div{padding:16px;border:1px solid var(--line);border-radius:10px;background:#f8f7f2}.data-coverage-grid strong,.data-coverage-grid span{display:block}.data-coverage-grid strong{font-size:.8rem}.data-coverage-grid span{margin-top:6px;color:var(--muted);font-size:.72rem;line-height:1.5}.project-status{display:inline-block;padding:6px 9px;border-radius:20px;background:#e5e8e5;color:#55645f;font-size:.7rem;font-weight:800}.project-status.active,.project-status.completed{background:var(--teal-soft);color:#28675d}.project-status.paused,.project-status.awaiting_approval,.project-status.policy_hold{background:#f5e8c9;color:#8a5f19}.project-status.cancelled,.project-status.failed,.project-status.completed_with_errors{background:#f5ded9;color:#8f3d31}.project-status.large{padding:9px 13px;font-size:.76rem}.project-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel-body{padding:25px}.panel-body>p{margin-top:0;color:var(--muted);font-size:.83rem;line-height:1.6}.button-row,.project-controls{display:flex;flex-wrap:wrap;gap:10px}.secondary-button{border:1px solid #aebbb6;border-radius:8px;padding:10px 13px;background:white;color:var(--ink);font-size:.78rem;font-weight:750}.limits{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:26px 0 0}.limits div{padding-top:13px;border-top:1px solid var(--line)}.limits dt{color:var(--muted);font-size:.7rem;text-transform:uppercase}.limits dd{margin:6px 0 0;font-size:.82rem;font-weight:700}.check-label{display:flex!important;align-items:flex-start;gap:10px;margin-top:17px!important}.check-label input{width:auto!important;margin-top:3px}.release-form button{width:100%;margin-top:18px}.project-section{margin-top:20px}.project-controls{justify-content:flex-end;margin-top:20px}.flash{margin-bottom:20px;padding:13px 16px;border:1px solid #b8d8ce;border-radius:9px;background:var(--teal-soft);color:#315e57;font-size:.82rem}.warning-card{margin-top:20px;padding:20px;border:1px solid #dbbd84;border-radius:12px;background:#fff4dc}.warning-card p{margin-bottom:0;color:var(--muted)}
.status-track{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}.pipeline-stage{display:flex;align-items:center;gap:12px;padding:15px;border:1px solid var(--line);border-radius:11px;background:#ebe9e3}.pipeline-stage>span{display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;border-radius:50%;background:#9aa3a0;color:white;font-size:.75rem;font-weight:850}.pipeline-stage.complete{border-color:#b8d8ce;background:#eef7f3}.pipeline-stage.complete>span{background:var(--teal)}.pipeline-stage strong,.pipeline-stage small{display:block}.pipeline-stage strong{font-size:.78rem}.pipeline-stage small{margin-top:4px;color:var(--muted);font-size:.67rem;line-height:1.35}.spine-grid{grid-template-columns:minmax(0,2.4fr) minmax(280px,1fr)}.spine-filters{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr)) auto auto;align-items:end;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line);background:#faf9f4}.spine-filters label{color:var(--muted);font-size:.7rem;font-weight:750}.spine-filters input,.spine-filters select{display:block;width:100%;height:40px;margin-top:6px;border:1px solid #b9c1bc;border-radius:8px;padding:0 10px;background:white;color:var(--ink)}.spine-filters button{height:40px;border:0;border-radius:8px;padding:0 16px;background:var(--teal);color:white;font-size:.78rem;font-weight:750}.spine-filters .secondary-link{height:40px}.work-summary{display:grid;grid-template-columns:1fr 1fr;gap:20px}.inventory-notes{margin:0;padding-left:20px;color:var(--muted);font-size:.8rem;line-height:1.7}.preset-links{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}.selected-filter{border-color:var(--teal);background:var(--teal-soft);color:var(--teal)}.explorer-filters{grid-template-columns:minmax(220px,2fr) minmax(140px,1fr) minmax(140px,1fr) auto auto}.bulk-toolbar{display:flex;align-items:end;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line);background:#fffefa}.bulk-toolbar label{min-width:280px;margin-left:auto;color:var(--muted);font-size:.7rem;font-weight:750}.bulk-toolbar select{display:block;width:100%;height:40px;margin-top:6px;border:1px solid #b9c1bc;border-radius:8px;padding:0 10px;background:white}.bulk-toolbar>button[type=submit]{height:40px;border:0;border-radius:8px;padding:0 16px;background:var(--teal);color:white;font-size:.78rem;font-weight:750}.bulk-toolbar button:disabled{opacity:.45}.pagination{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;color:var(--muted);font-size:.78rem}.pagination div{display:flex;gap:8px}.profile-details{display:grid;gap:14px;margin:20px 0 0}.profile-details div{padding-top:12px;border-top:1px solid var(--line)}.profile-details dt{color:var(--muted);font-size:.7rem;text-transform:uppercase}.profile-details dd{margin:6px 0 0;font-size:.84rem;overflow-wrap:anywhere}.attribute-grid{grid-template-columns:repeat(3,1fr)}.profile-identifiers{padding:8px 0 0}.profile-identifiers li span{overflow-wrap:anywhere}
@media(max-width:1100px){.spine-filters,.explorer-filters{grid-template-columns:repeat(2,1fr)}.bulk-toolbar{align-items:stretch;flex-wrap:wrap}.bulk-toolbar label{margin-left:0}}
@media(max-width:960px){.login-shell{grid-template-columns:1fr}.login-brand{min-height:46vh;padding:52px}.login-panel{padding:36px 20px}.metrics{grid-template-columns:repeat(2,1fr)}.content-grid,.project-grid,.spine-grid{grid-template-columns:1fr}.status-track{grid-template-columns:repeat(2,1fr)}.coverage-spine{grid-template-columns:repeat(2,1fr)}.form-grid.three-columns{grid-template-columns:repeat(2,1fr)}.choice-builder{grid-template-columns:1fr}.breakdown-panel{order:-1}.breakdown{display:grid;grid-template-columns:repeat(2,1fr);gap:0 24px}.dashboard-heading{align-items:start}.freshness{margin-top:8px}}
@media(max-width:640px){.login-brand{padding:38px 24px}.login-brand h1{font-size:3rem}.login-card{padding:30px 24px}.topbar{height:auto;padding:14px 18px}.topbar-actions{gap:10px;flex-wrap:wrap;justify-content:flex-end}.local-badge{display:none}.dashboard{width:calc(100% - 28px);padding-top:34px}.dashboard-heading{display:block}.dashboard-heading .project-status{margin-top:18px}.freshness{margin-top:22px}.metrics{grid-template-columns:1fr 1fr;gap:10px}.metric-card{padding:18px}.panel-heading{align-items:stretch;flex-direction:column;padding:20px}.search{width:100%}.breakdown{grid-template-columns:1fr}.notice{align-items:flex-start}.status-track,.spine-filters,.explorer-filters,.work-summary,.coverage-spine,.form-grid,.form-grid.three-columns,.limits,.data-coverage-grid,.work-mode,.attribute-grid{grid-template-columns:1fr}.wide-field{grid-column:auto}.choice-list{grid-template-columns:1fr}.scale-note{display:block}.scale-note strong{display:block;margin-bottom:8px}.form-section{padding:22px 18px}.bulk-toolbar{display:grid}.bulk-toolbar label{min-width:0}.pagination{align-items:flex-start;gap:12px;flex-direction:column}footer{padding:20px;flex-direction:column;gap:8px}}
`;

const ORGANIZATION_RECORDS_SCRIPT = `
(() => {
  const form = document.querySelector('[data-record-selection]');
  if (!(form instanceof HTMLFormElement)) return;
  const checkboxes = [...form.querySelectorAll('input[name="recordIds"]')]
    .filter((item) => item instanceof HTMLInputElement);
  form.querySelector('[data-select-page]')?.addEventListener('click', () => {
    for (const checkbox of checkboxes) checkbox.checked = true;
  });
  form.querySelector('[data-clear-page]')?.addEventListener('click', () => {
    for (const checkbox of checkboxes) checkbox.checked = false;
  });
})();
`;

const PROJECT_BUILDER_SCRIPT = `
(() => {
  const builder = document.querySelector('[data-project-builder]');
  if (!(builder instanceof HTMLFormElement)) return;
  const template = builder.querySelector('#template');
  const state = builder.querySelector('#statePreview');
  const level = builder.querySelector('#levelPreview');
  const sector = builder.querySelector('#sectorPreview');
  const source = builder.querySelector('[data-choice-source]');
  const selected = builder.querySelector('[data-choice-selected]');
  const select = builder.querySelector('[data-choice-select]');
  const empty = builder.querySelector('[data-choice-empty]');
  const scopeStatus = builder.querySelector('[data-scope-status]');
  const createButton = builder.querySelector('[data-create-project]');
  if (!(template instanceof HTMLSelectElement) || !(state instanceof HTMLSelectElement)
      || !(level instanceof HTMLSelectElement) || !(sector instanceof HTMLSelectElement)
      || !(source instanceof HTMLElement) || !(selected instanceof HTMLElement)
      || !(select instanceof HTMLSelectElement) || !(empty instanceof HTMLElement)
      || !(scopeStatus instanceof HTMLElement) || !(createButton instanceof HTMLButtonElement)) return;

  let dragged = null;
  const syncEmpty = () => { empty.hidden = selected.children.length > 0; };
  const setSelected = (button, include) => {
    const code = button.dataset.choiceCode;
    if (!code) return;
    const option = [...select.options].find((item) => item.value === code);
    if (option) option.selected = include;
    (include ? selected : source).append(button);
    syncEmpty();
  };
  const filterTypes = () => {
    const levels = [level.value].filter(Boolean);
    const sectors = [sector.value].filter(Boolean);
    for (const button of builder.querySelectorAll('[data-choice-code]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const typeLevel = button.dataset.defaultLevel || '';
      const typeSector = button.dataset.defaultSector || '';
      const relevant = (!typeLevel || levels.includes(typeLevel))
        && (!typeSector || sectors.includes(typeSector));
      button.hidden = !relevant;
      if (!relevant && button.parentElement === selected) setSelected(button, false);
    }
  };
  const applyTemplate = () => {
    const option = template.selectedOptions[0];
    if (!option) return;
    const levels = (option.dataset.levels || '').split(',').filter(Boolean);
    const sectors = (option.dataset.sectors || '').split(',').filter(Boolean);
    state.value = option.dataset.state || '';
    level.value = levels[0] || '';
    sector.value = sectors[0] || '';
    createButton.disabled = false;
    scopeStatus.classList.remove('unavailable');
    scopeStatus.textContent = 'Ready: ' + option.textContent;
    filterTypes();
  };
  const resolveTemplate = () => {
    const match = [...template.options].find((option) => {
      const sectors = (option.dataset.sectors || '').split(',').filter(Boolean);
      return ((option.dataset.national === 'true') || (option.dataset.state || '') === state.value)
        && (option.dataset.levels || '') === level.value
        && sectors.includes(sector.value);
    });
    if (match) {
      template.value = match.value;
      createButton.disabled = false;
      scopeStatus.classList.remove('unavailable');
      scopeStatus.textContent = 'Ready: ' + match.textContent;
    } else {
      createButton.disabled = true;
      scopeStatus.classList.add('unavailable');
      scopeStatus.textContent = 'This combination needs a reviewed jurisdiction and source configuration before it can run.';
    }
    filterTypes();
  };
  for (const button of builder.querySelectorAll('[data-choice-code]')) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.addEventListener('click', () => setSelected(button, button.parentElement !== selected));
    button.addEventListener('dragstart', () => { dragged = button; });
    button.addEventListener('dragend', () => { dragged = null; });
  }
  for (const bin of builder.querySelectorAll('.choice-bin')) {
    if (!(bin instanceof HTMLElement)) continue;
    bin.addEventListener('dragover', (event) => { event.preventDefault(); bin.classList.add('drag-over'); });
    bin.addEventListener('dragleave', () => bin.classList.remove('drag-over'));
    bin.addEventListener('drop', (event) => {
      event.preventDefault();
      bin.classList.remove('drag-over');
      if (dragged instanceof HTMLButtonElement) setSelected(dragged, bin.hasAttribute('data-choice-target'));
    });
  }
  template.addEventListener('change', applyTemplate);
  state.addEventListener('change', resolveTemplate);
  level.addEventListener('change', resolveTemplate);
  sector.addEventListener('change', resolveTemplate);
  applyTemplate();
  syncEmpty();
})();
`;

async function main(): Promise<void> {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const hosted = process.env['RENDER'] === 'true';
  const email = hosted ? process.env['ADMIN_EMAIL'] : process.env['LOCAL_ADMIN_EMAIL'];
  const password = hosted ? undefined : process.env['LOCAL_ADMIN_PASSWORD'];
  const passwordHash = hosted ? process.env['ADMIN_PASSWORD_HASH'] : undefined;
  const sessionSecret = hosted
    ? process.env['ADMIN_SESSION_SECRET']
    : process.env['LOCAL_ADMIN_SESSION_SECRET'];
  if (email === undefined || sessionSecret === undefined) {
    throw new Error('Admin email or session secret is missing.');
  }
  if (hosted && passwordHash === undefined) {
    throw new Error('Hosted admin password hash is missing.');
  }
  if (!hosted && password === undefined) {
    throw new Error('Local admin credentials are missing. Run the local setup instructions.');
  }
  if (hosted && sessionSecret.length < 32) {
    throw new Error('Hosted admin session secret must contain at least 32 characters.');
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (hosted && (databaseUrl === undefined || databaseUrl.trim().length === 0)) {
    throw new Error('Hosted admin requires DATABASE_URL and never uses the embedded database.');
  }
  const publicOrigin = hosted
    ? normalizeHostedOrigin(
        process.env['ADMIN_PUBLIC_ORIGIN'] ?? process.env['RENDER_EXTERNAL_URL'],
      )
    : undefined;
  const databasePath = resolve(process.env['LOCAL_DATABASE_PATH'] ?? DEFAULT_DATABASE_PATH);
  const database =
    databaseUrl === undefined || databaseUrl.trim().length === 0
      ? await PGliteClient.open(databasePath)
      : new PostgresClient({ connectionString: databaseUrl, max: 4 });
  if (database instanceof PGliteClient) await migrate(database, loadMigrations());
  const taxonomy = buildTaxonomy();
  const projectTemplates: CollectionProjectTemplate[] = buildJurisdictionRegistry()
    .list()
    .map((config) => ({
      key: config.key,
      name: config.name,
      governmentLevelCode: config.governmentLevelCode,
      sectorCodes: config.sectorCodes,
      jurisdictionCode: config.jurisdiction.code,
      stateCode: config.jurisdiction.stateCode,
      officialSources: config.officialSources,
      notes: config.notes,
      defaultMaxPagesPerTarget: config.crawlPolicy.maxPagesPerRun,
    }));
  const server = createAdminServer({
    database,
    email,
    password,
    passwordHash,
    sessionSecret,
    hosted,
    publicOrigin,
    projectTemplates,
    projectBuilderCatalog: {
      governmentLevels: taxonomy.governmentLevels,
      sectors: taxonomy.sectors,
      organizationTypes: taxonomy.organizationTypes,
      explorerPresets: taxonomy.explorerPresets,
      states: buildOrganizationSpineInventory().states.map((state) => ({
        ...state,
        description: 'State or District of Columbia location filter.',
      })),
    },
    organizationSpineInventory: buildOrganizationSpineInventory(),
  });
  const port = numberFromEnvironment(
    process.env['PORT'] ?? process.env['ADMIN_PORT'] ?? process.env['CONDUCTOR_PORT'],
    4173,
  );
  const host = process.env['ADMIN_HOST'] ?? (hosted ? '0.0.0.0' : '127.0.0.1');
  const logger = createLogger({ name: hosted ? 'hosted-admin' : 'local-admin' });
  server.listen(port, host, () => {
    logger.info(
      {
        url: publicOrigin ?? `http://${host}:${port}`,
        database: databaseUrl === undefined ? databasePath : 'remote PostgreSQL',
      },
      'operator console ready',
    );
  });

  const close = (): void => {
    server.close(() => {
      void database.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function normalizeHostedOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error('Hosted admin public origin is missing.');
  const origin = new URL(value).origin;
  if (!origin.startsWith('https://')) throw new Error('Hosted admin public origin must use HTTPS.');
  return origin;
}

function numberFromEnvironment(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function policyValue(form: URLSearchParams, name: string) {
  const value = form.get(name);
  if (!['permitted', 'prohibited', 'review_required', 'unknown'].includes(value ?? '')) {
    throw new Error(`${name} is not valid`);
  }
  return value as 'permitted' | 'prohibited' | 'review_required' | 'unknown';
}

function stanceValue(form: URLSearchParams, name: string) {
  const value = form.get(name);
  if (!['permitted', 'prohibited', 'restricted', 'unknown'].includes(value ?? '')) {
    throw new Error(`${name} is not valid`);
  }
  return value as 'permitted' | 'prohibited' | 'restricted' | 'unknown';
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
