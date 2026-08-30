import { describe, expect, it } from 'vitest';
import { CrawlEngine, SourcePolicyRegistry, fixedClock, withPolicyDefaults } from '@pan/core';
import { createSilentLogger } from '@pan/observability';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import { genericJsonAdapter } from '@pan/adapter-generic-json';
import type { CrawlJob } from '@pan/core';
import type { CrawlCheckpoint, SourcePolicyRecord } from '@pan/shared-types';
import { MapFetcher, StubRobotsProvider, recordingSleep } from './support/fetchers.js';
import { readFixture } from './support/fixtures.js';
import { allSectorsTaxonomy } from './support/taxonomy.js';

const VOCABULARY = allSectorsTaxonomy().vocabulary;

const CLOCK = fixedClock('2026-06-01T00:00:00.000Z');
const LOGGER = createSilentLogger();

function engine(
  fetcher: MapFetcher,
  overrides: Partial<ConstructorParameters<typeof CrawlEngine>[0]> = {},
): CrawlEngine {
  return new CrawlEngine({
    fetcher,
    robots: new StubRobotsProvider(),
    logger: LOGGER,
    clock: CLOCK,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

function job(overrides: Partial<CrawlJob> & { seedUrl: string }): CrawlJob {
  return {
    crawlRunId: 'run-1',
    crawlTargetId: 'target-1',
    adapter: genericHtmlAdapter,
    vocabulary: VOCABULARY,
    // Fixture mode: nothing is collected, so the source-policy gate does not apply.
    collectionMode: 'fixture',
    policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false }),
    ...overrides,
  };
}

const html = (path: string): string => readFixture('directory-platforms', path);

const NUMBERED = {
  'https://sample-isd.example.org/staff-directory?page=1': html(
    'generic-html/table-numbered/page-1.html',
  ),
  'https://sample-isd.example.org/staff-directory?page=2': html(
    'generic-html/table-numbered/page-2.html',
  ),
  'https://sample-isd.example.org/staff-directory?page=3': html(
    'generic-html/table-numbered/page-3.html',
  ),
};

describe('CrawlEngine pagination', () => {
  it('walks every page of a numbered pager and collects each record once', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory?page=1' }),
    );

    expect(result.stats.pagesFetched).toBe(3);
    expect(result.records).toHaveLength(9);
    expect(new Set(result.records.map((r) => r.record.recordKey)).size).toBe(9);
    expect(result.stops.map((s) => s.reason)).toContain('completed');
  });

  it('does not treat a numbered pager linking backwards as a loop', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory?page=1' }),
    );
    expect(result.stops.map((s) => s.reason)).not.toContain('pagination_loop');
  });

  it('follows a rel=next chain to the end', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/faculty': html('generic-html/cards-next-link/page-1.html'),
      'https://sample-isd.example.org/faculty?page=2': html(
        'generic-html/cards-next-link/page-2.html',
      ),
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/faculty' }),
    );
    expect(result.stats.pagesFetched).toBe(2);
    expect(result.records).toHaveLength(7);
  });

  it('stops a sequential pager that cycles back to a page already followed', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/directory/page-a': html(
        'generic-html/pagination-loop/page-a.html',
      ),
      'https://sample-isd.example.org/directory/page-b': html(
        'generic-html/pagination-loop/page-b.html',
      ),
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/directory/page-a' }),
    );

    expect(result.stops.map((s) => s.reason)).toContain('pagination_loop');
    expect(result.stats.pagesFetched).toBe(2);
    expect(result.records).toHaveLength(6);
  });

  it('paginates a cursor-based json api', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/api/staff': {
        body: readFixture('directory-platforms', 'generic-json/cursor-api/page-1.json'),
        contentType: 'application/json',
      },
      'https://sample-isd.example.org/api/staff?cursor=eyJwYWdlIjoyfQ': {
        body: readFixture('directory-platforms', 'generic-json/cursor-api/page-2.json'),
        contentType: 'application/json',
      },
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/api/staff', adapter: genericJsonAdapter }),
    );
    expect(result.stats.pagesFetched).toBe(2);
    expect(result.records.map((r) => r.record.fullNamePublished)).toContain('Miriam Katz');
  });
});

describe('CrawlEngine guards', () => {
  it('stops when the page budget is exhausted', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false, maxPagesPerRun: 2 }),
      }),
    );
    expect(result.stats.pagesFetched).toBe(2);
    expect(result.stops.map((s) => s.reason)).toContain('page_budget_exhausted');
  });

  it('stops when a page repeats content already seen', async () => {
    const duplicate = html('generic-html/cards-next-link/page-1.html');
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/faculty': duplicate,
      'https://sample-isd.example.org/faculty?page=2': duplicate,
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/faculty' }),
    );
    expect(result.stops.map((s) => s.reason)).toContain('duplicate_content');
    expect(result.records).toHaveLength(4);
  });

  it('reports empty_success when a page parses cleanly but holds nobody', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/staff-directory': html(
        'generic-html/empty-directory/index.html',
      ),
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory' }),
    );
    expect(result.stops.map((s) => s.reason)).toContain('empty_success');
    expect(result.records).toHaveLength(0);
  });

  it('refuses to leave the seed domain', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/index': html('generic-html/discovery/index.html'),
      'https://unrelated-vendor.example.net/staff-directory': html(
        'generic-html/table-numbered/page-1.html',
      ),
    });
    await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/index', followProfiles: true }),
    );
    expect(fetcher.requested).not.toContain('https://unrelated-vendor.example.net/staff-directory');
  });

  it('never fetches an excluded url such as a calendar', async () => {
    const withCalendarNext = `<html><body><h1>Staff</h1>
      <table><thead><tr><th>Name</th><th>Email</th></tr></thead>
      <tbody><tr><td>Jane Smith</td><td><a href="mailto:jane@sample-isd.example.org">e</a></td></tr></tbody></table>
      <a href="/calendar/2026-09" rel="next">Next</a></body></html>`;
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/staff': withCalendarNext,
      'https://sample-isd.example.org/calendar/2026-09': '<html><body>calendar</body></html>',
    });
    await engine(fetcher).run(job({ seedUrl: 'https://sample-isd.example.org/staff' }));
    expect(fetcher.requested).not.toContain('https://sample-isd.example.org/calendar/2026-09');
  });

  it('stops after repeated pages that add no new records', async () => {
    const page = (next: string, name: string): string =>
      `<html><body><h1>Staff</h1><table><thead><tr><th>Name</th><th>Email</th></tr></thead>
       <tbody><tr><td>${name}</td><td><a href="mailto:${name.toLowerCase().replace(' ', '.')}@sample-isd.example.org">e</a></td></tr></tbody></table>
       <a href="${next}" rel="next">Next</a></body></html>`;
    // Every page after the first republishes the same person under a new url.
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/s?p=1': page('/s?p=2', 'Jane Smith'),
      'https://sample-isd.example.org/s?p=2': page('/s?p=3', 'Jane Smith'),
      'https://sample-isd.example.org/s?p=3': page('/s?p=4', 'Jane Smith'),
      'https://sample-isd.example.org/s?p=4': page('/s?p=5', 'Jane Smith'),
      'https://sample-isd.example.org/s?p=5': page('/s?p=6', 'Jane Smith'),
    });
    const result = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/s?p=1',
        policy: withPolicyDefaults({
          requestDelayMs: 0,
          respectRobots: false,
          maxPagesWithoutNewRecords: 2,
        }),
      }),
    );
    expect(result.stops.map((s) => s.reason)).toContain('no_progress');
    expect(result.stats.pagesFetched).toBeLessThan(5);
  });

  it('stops and records the page when a challenge is presented, without retrying', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/staff':
        '<html><body><div class="cf-challenge">Verify you are human</div></body></html>',
    });
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff' }),
    );
    expect(result.errors.map((e) => e.errorType)).toContain('captcha');
    expect(result.stops.map((s) => s.reason)).toContain('blocked_by_source');
    expect(fetcher.requested).toHaveLength(1);
  });
});

describe('CrawlEngine robots handling', () => {
  it('records a blocked source and stops instead of fetching it', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/private/staff': html(
        'generic-html/table-numbered/page-1.html',
      ),
    });
    const result = await engine(fetcher, { robots: new StubRobotsProvider(['/private']) }).run(
      job({
        seedUrl: 'https://sample-isd.example.org/private/staff',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: true }),
      }),
    );
    expect(fetcher.requested).toHaveLength(0);
    expect(result.errors.map((e) => e.errorType)).toContain('robots_disallowed');
    expect(result.stops.map((s) => s.reason)).toContain('blocked_by_robots');
  });
});

describe('CrawlEngine retries and rate limiting', () => {
  it('retries a transient failure and then succeeds', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/faculty': html('generic-html/cards-next-link/page-1.html'),
      'https://sample-isd.example.org/faculty?page=2': html(
        'generic-html/cards-next-link/page-2.html',
      ),
    }).failTimes('https://sample-isd.example.org/faculty', 2, { retryable: true });

    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/faculty' }),
    );
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.errors.filter((e) => e.retryable)).toHaveLength(2);
  });

  it('does not retry a refusal such as 403', async () => {
    const fetcher = MapFetcher.from({
      'https://sample-isd.example.org/faculty': html('generic-html/cards-next-link/page-1.html'),
    }).failTimes('https://sample-isd.example.org/faculty', 5, { retryable: false, status: 403 });

    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/faculty' }),
    );
    expect(fetcher.requested).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.retryable).toBe(false);
  });

  it('waits the configured delay between requests to a domain', async () => {
    const { sleep, calls } = recordingSleep();
    const fetcher = MapFetcher.from(NUMBERED);
    await engine(fetcher, { sleep }).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        policy: withPolicyDefaults({ requestDelayMs: 1500, respectRobots: false }),
      }),
    );
    expect(calls.filter((ms) => ms === 1500).length).toBeGreaterThanOrEqual(2);
  });
});

describe('CrawlEngine checkpointing', () => {
  it('emits a checkpoint after each page and can resume from it', async () => {
    const checkpoints: CrawlCheckpoint[] = [];
    const fetcher = MapFetcher.from(NUMBERED);
    const firstRun = await engine(fetcher, { onCheckpoint: (cp) => void checkpoints.push(cp) }).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false, maxPagesPerRun: 1 }),
      }),
    );
    expect(firstRun.records).toHaveLength(3);
    expect(checkpoints.length).toBeGreaterThan(0);

    const resumeFetcher = MapFetcher.from(NUMBERED);
    const resumed = await engine(resumeFetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        resumeFrom: firstRun.checkpoint,
      }),
    );
    expect(resumeFetcher.requested).not.toContain(
      'https://sample-isd.example.org/staff-directory?page=1',
    );
    expect(resumed.records).toHaveLength(6);
  });

  it('a resumed run does not re-emit records already harvested', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const first = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false, maxPagesPerRun: 2 }),
      }),
    );
    const second = await engine(MapFetcher.from(NUMBERED)).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        resumeFrom: first.checkpoint,
      }),
    );
    const allKeys = [...first.records, ...second.records].map((r) => r.record.recordKey);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});

describe('CrawlEngine idempotency', () => {
  it('produces identical record keys when the same pages are crawled again', async () => {
    const first = await engine(MapFetcher.from(NUMBERED)).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory?page=1' }),
    );
    const second = await engine(MapFetcher.from(NUMBERED)).run(
      job({
        crawlRunId: 'run-2',
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
      }),
    );
    expect(second.records.map((r) => r.record.recordKey)).toEqual(
      first.records.map((r) => r.record.recordKey),
    );
  });

  it('carries the source page and content hash on every harvested record', async () => {
    const result = await engine(MapFetcher.from(NUMBERED)).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory?page=1' }),
    );
    for (const harvested of result.records) {
      expect(harvested.sourceUrl).toMatch(/^https:\/\/sample-isd\.example\.org\//);
      expect(harvested.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(harvested.fetchedAt).toBeTruthy();
    }
  });
});

describe('CrawlEngine source policy gate', () => {
  function policy(overrides: Partial<SourcePolicyRecord> & { id: string }): SourcePolicyRecord {
    return {
      domain: null,
      urlPattern: null,
      organizationId: null,
      jurisdictionId: null,
      sourceTypeCode: null,
      collectionStatus: 'unknown',
      commercialUseStatus: 'unknown',
      solicitationStatus: 'unknown',
      automatedAccessStatus: 'unknown',
      policyUrl: null,
      policyTextSnapshot: null,
      policyTextHash: null,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      lastReviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
      productionApprovedBy: null,
      productionApprovedAt: null,
      productionApprovalNote: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('refuses a production run against a prohibited source without fetching it', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        collectionMode: 'production',
        sourcePolicy: new SourcePolicyRegistry([
          policy({ id: 'p1', domain: 'sample-isd.example.org', collectionStatus: 'prohibited' }),
        ]),
      }),
    );
    expect(fetcher.requested).toHaveLength(0);
    expect(result.errors.map((e) => e.errorType)).toContain('source_policy_refusal');
    expect(result.stops.map((s) => s.reason)).toContain('blocked_by_source_policy');
  });

  it('refuses a production run against a source nobody has reviewed', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        collectionMode: 'production',
        sourcePolicy: SourcePolicyRegistry.empty(),
      }),
    );
    expect(fetcher.requested).toHaveLength(0);
    expect(result.stops.map((s) => s.reason)).toContain('blocked_by_source_policy');
  });

  it('allows a production run against a permitted source', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({
        seedUrl: 'https://sample-isd.example.org/staff-directory?page=1',
        collectionMode: 'production',
        sourcePolicy: new SourcePolicyRegistry([
          policy({ id: 'p1', domain: 'sample-isd.example.org', collectionStatus: 'permitted' }),
        ]),
      }),
    );
    expect(result.records).toHaveLength(9);
  });

  it('does not gate a fixture run, because nothing is collected', async () => {
    const fetcher = MapFetcher.from(NUMBERED);
    const result = await engine(fetcher).run(
      job({ seedUrl: 'https://sample-isd.example.org/staff-directory?page=1' }),
    );
    expect(result.records).toHaveLength(9);
  });
});
