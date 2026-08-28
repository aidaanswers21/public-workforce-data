import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
  DiscoveredDirectory,
  ExtractedPersonRecord,
  FetchedPage,
  ListingExtraction,
  PaginationPlan,
} from '@pan/shared-types';
import {
  AdapterRegistry,
  buildPersonRecord,
  checkAdapterContract,
  fixturePage,
} from '@pan/adapter-kit';
import { CrawlEngine, PermissiveRobotsProvider, withPolicyDefaults } from '@pan/core';
import { createSilentLogger } from '@pan/observability';
import { StateRegistry, validateStateConfig, type StateConfig } from '@pan/state-kit';
import { buildAdapterRegistry, buildStateRegistry } from '@pan/crawler-worker';
import { MapFetcher } from './support/fetchers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A directory platform invented entirely inside this test file.
 *
 * If this adapter works end to end without a single change anywhere else in the
 * repository, the seam does what the documentation says it does.
 */
class PipeDelimitedAdapter implements DirectoryAdapter {
  readonly key = 'test-pipe-delimited';
  readonly version = '1.0.0';
  readonly displayName = 'Pipe delimited staff list';
  readonly detectionThreshold = 0.5;
  readonly requiresBrowser = false;

  detect(context: DetectionContext): DetectionResult {
    const score = context.page?.body.startsWith('STAFF|') === true ? 0.99 : 0;
    return { adapterKey: this.key, score, platformKey: 'pipe', reasons: ['leading STAFF| marker'] };
  }

  discoverDirectories(): readonly DiscoveredDirectory[] {
    return [];
  }

  extractListing(page: FetchedPage): ListingExtraction {
    const records: ExtractedPersonRecord[] = [];
    const lines = page.body
      .split('\n')
      .slice(1)
      .filter((line) => line.trim().length > 0);

    lines.forEach((line, index) => {
      const [name, title, email] = line.split('|');
      const record = buildPersonRecord({
        adapterKey: this.key,
        sourceUrl: page.finalUrl,
        localKey: `${index}:${name ?? ''}`,
        fullNamePublished: name ?? '',
        titlePublished: title ?? null,
        emailSources: email === undefined ? [] : [email],
        extractionMethod: 'html_list',
        confidence: 0.85,
      });
      if (record !== null) records.push(record);
    });

    return {
      records,
      pagination: { kind: null, requests: [], exhausted: true, note: null },
      context: {},
      empty: records.length === 0,
      warnings: [],
    };
  }

  extractProfile(): ExtractedPersonRecord | null {
    return null;
  }

  discoverPagination(): PaginationPlan {
    return { kind: null, requests: [], exhausted: true, note: null };
  }
}

const PIPE_BODY = [
  'STAFF|v1',
  'Ada Lovelace|Mathematics Teacher|ada.lovelace@sample-isd.example.org',
  'Grace Hopper|Technology Director|grace.hopper@sample-isd.example.org',
  'Katherine Johnson|Physics Teacher|katherine.johnson@sample-isd.example.org',
].join('\n');

describe('a new directory adapter needs no change to the crawler core', () => {
  const adapter = new PipeDelimitedAdapter();

  it('passes the shared contract checks', () => {
    const failures = checkAdapterContract(adapter, {
      name: 'pipe delimited',
      url: 'https://sample-isd.example.org/staff.txt',
      html: PIPE_BODY,
      kind: 'listing',
      expected: { recordCount: 3, empty: false, paginationKind: null },
    }).filter((check) => !check.passed);
    expect(failures).toEqual([]);
  });

  it('is selected by the registry over the shipped generic adapters', () => {
    const registry = buildAdapterRegistry().register(adapter);
    const page = fixturePage({
      name: 'pipe',
      url: 'https://sample-isd.example.org/staff.txt',
      html: PIPE_BODY,
      kind: 'listing',
    });
    const selection = registry.select({ url: page.url, page, hints: {} });
    expect(selection.adapter.key).toBe(adapter.key);
  });

  it('runs through the unmodified crawl engine', async () => {
    const engine = new CrawlEngine({
      fetcher: MapFetcher.from({ 'https://sample-isd.example.org/staff.txt': PIPE_BODY }),
      robots: new PermissiveRobotsProvider(),
      logger: createSilentLogger(),
      sleep: () => Promise.resolve(),
    });
    const result = await engine.run({
      crawlRunId: 'run-ext',
      crawlTargetId: null,
      seedUrl: 'https://sample-isd.example.org/staff.txt',
      adapter,
      policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false }),
    });

    expect(result.records.map((r) => r.record.fullNamePublished)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Katherine Johnson',
    ]);
    for (const harvested of result.records) {
      expect(harvested.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('rejects a duplicate adapter key rather than shadowing one', () => {
    const registry = buildAdapterRegistry();
    expect(() => registry.register(adapter).register(adapter)).toThrow(/duplicate adapter key/);
  });

  it('reports an unclaimed page instead of guessing', () => {
    const registry = new AdapterRegistry().register(adapter);
    const page = fixturePage({
      name: 'other',
      url: 'https://x.example.org/',
      html: '<html><body>hello</body></html>',
      kind: 'listing',
    });
    expect(registry.trySelect({ url: page.url, page, hints: {} })).toBeNull();
  });
});

describe('a new state needs no change to anything but its own config', () => {
  const ohio: StateConfig = {
    code: 'OH',
    name: 'Ohio',
    fipsCode: '39',
    configKey: 'ohio',
    officialSources: [
      {
        key: 'test-source',
        name: 'Test source',
        url: 'https://example.invalid/districts.csv',
        sourceType: 'state_agency',
        format: 'csv',
        provides: 'districts',
        verified: false,
        verificationNote: 'placeholder for the extensibility test',
      },
    ],
    columnMappings: { testSource: { districtName: 'NAME', countyName: 'COUNTY' } },
    identifierMappings: [
      {
        field: 'stateAgencyId',
        officialName: 'IRN',
        pattern: '^\\d{6}$',
        description: 'placeholder',
      },
    ],
    countyAliases: {},
    expectedCountyCount: 88,
    seedInstitutions: [],
    crawlPolicy: { requestDelayMs: 3000 },
    domainDenyList: [],
    extraUrlExclusions: [],
    notes: [],
  };

  it('validates with no errors', () => {
    expect(validateStateConfig(ohio).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('registers alongside the shipped state', () => {
    const registry = buildStateRegistry().register(ohio);
    expect(registry.codes()).toEqual(['OH', 'TX']);
    expect(registry.get('oh').crawlPolicy.requestDelayMs).toBe(3000);
  });

  it('refuses two configs for the same state', () => {
    expect(() => new StateRegistry().register(ohio).register(ohio)).toThrow(/already registered/);
  });
});

describe('the crawler core carries no state-specific or platform-specific knowledge', () => {
  const coreFiles = [
    'packages/core/src/crawl/engine.ts',
    'packages/core/src/crawl/guards.ts',
    'packages/core/src/crawl/policy.ts',
  ];

  it.each(coreFiles)('%s mentions no state or platform by name', (file) => {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    expect(source).not.toMatch(/\btexas\b/i);
    expect(source).not.toMatch(/\bisd\b/i);
    expect(source).not.toMatch(/generic-html|generic-json/);
  });

  it('the crawl engine does not import any adapter or state package', () => {
    const source = readFileSync(join(repoRoot, 'packages/core/src/crawl/engine.ts'), 'utf8');
    expect(source).not.toMatch(/@pan\/adapter-/);
    expect(source).not.toMatch(/@pan\/state-/);
  });
});
