import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, type Logger } from '@public-workforce/observability';
import {
  ExportPurposeRepository,
  QueryRepository,
  type SqlClient,
} from '@public-workforce/database';

export interface ApiCaller {
  subject: string;
}

export interface ApiOptions {
  client: SqlClient;
  logger?: Logger;
  port?: number;
  authenticate: (request: IncomingMessage) => Promise<ApiCaller | null> | ApiCaller | null;
}

/**
 * Minimal read-only API over coverage and records.
 *
 * Read-only by design for the foundation: this service can answer questions
 * about what has been collected, and it has no route that sends anything, adds
 * a suppression bypass, or exports without going through the export path that
 * enforces suppression. Anything richer belongs in docs/BACKLOG.md, not here.
 */
export function createApi(options: ApiOptions): ReturnType<typeof createServer> {
  const logger = options.logger ?? createLogger({ name: 'pan-api' });
  const queries = new QueryRepository(options.client);
  const purposes = new ExportPurposeRepository(options.client);

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, queries, purposes, options.authenticate, logger);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  queries: QueryRepository,
  purposes: ExportPurposeRepository,
  authenticate: ApiOptions['authenticate'],
  logger: Logger,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method !== 'GET') {
    send(response, 405, { error: 'this service is read-only' });
    return;
  }

  try {
    if (url.pathname === '/health') {
      send(response, 200, { status: 'ok' });
      return;
    }

    const caller = await authenticate(request);
    if (caller === null || caller.subject.trim() === '') {
      response.setHeader('www-authenticate', 'Bearer');
      send(response, 401, { error: 'authentication required' });
      return;
    }

    if (url.pathname === '/coverage') {
      const level = url.searchParams.get('level');
      const sector = url.searchParams.get('sector');
      send(
        response,
        200,
        await queries.coverageSummary({
          ...(level === null ? {} : { governmentLevelCode: level }),
          ...(sector === null ? {} : { sectorCode: sector }),
        }),
      );
      return;
    }

    if (url.pathname === '/records') {
      const at = new Date().toISOString();
      const level = url.searchParams.get('level');
      const sector = url.searchParams.get('sector');
      // A read still declares a purpose, so export_purpose suppression applies
      // to browsing exactly as it applies to a written file.
      const purpose = url.searchParams.get('purpose') ?? 'internal-review';
      if ((await purposes.findActive(purpose)) === null) {
        send(response, 403, { error: 'purpose is not active and approved' });
        return;
      }
      const rows = await queries.queryExportableRows(at, purpose, {
        ...(level === null ? {} : { governmentLevelCode: level }),
        ...(sector === null ? {} : { sectorCode: sector }),
        limit: Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50),
      });
      send(response, 200, { at, purpose, count: rows.length, rows });
      return;
    }

    send(response, 404, { error: 'not found' });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'request failed',
    );
    send(response, 500, { error: 'internal error' });
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}
