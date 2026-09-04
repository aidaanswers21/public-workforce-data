import { describe, expect, it, vi } from 'vitest';
import { SourcePolicyRegistry } from '@public-workforce/core';
import { AdapterRegistry } from '@public-workforce/adapter-kit';
import { createSilentLogger } from '@public-workforce/observability';
import type { DirectoryVocabulary, Fetcher, RobotsProvider } from '@public-workforce/shared-types';
import type { SqlClient } from '@public-workforce/database';
import { DiscoveryWorker } from './index.js';

const vocabulary: DirectoryVocabulary = {
  headingTerms: [],
  urlHints: [],
  sharedInboxLocalParts: [],
  sharedInboxPrefixes: [],
  organizationLabelWords: [],
  titleIndicatorTerms: [],
  organizationFieldAliases: [],
  organizationNameSuffixes: [],
};

const target = {
  organizationId: 'organization-id',
  jurisdictionId: null,
  siteUrl: 'https://agency.example.gov',
  organizationName: 'Example Agency',
  parentOrganizationName: null,
};

describe('discovery source controls', () => {
  it('records a policy hold and does not fetch an unreviewed source', async () => {
    const fetch = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const worker = createWorker({ fetch, query });

    const result = await worker.discover(target);

    expect(result).toMatchObject({ blocked: true, targetsRecorded: 0 });
    expect(result.note).toMatch(/must review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('crawl_targets'), [
      'organization-id',
      null,
      'https://agency.example.gov/',
      expect.any(String),
      'policy_hold',
      expect.stringMatching(/must review/),
    ]);
  });

  it('records a robots block before fetching an otherwise permitted source', async () => {
    const fetch = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const worker = createWorker({
      fetch,
      query,
      sourcePolicy: new SourcePolicyRegistry([
        {
          id: 'policy-id',
          domain: 'agency.example.gov',
          urlPattern: null,
          organizationId: null,
          jurisdictionId: null,
          sourceTypeCode: 'html_directory',
          collectionStatus: 'permitted',
          commercialUseStatus: 'unknown',
          solicitationStatus: 'unknown',
          automatedAccessStatus: 'permitted',
          policyUrl: null,
          policyTextSnapshot: null,
          policyTextHash: null,
          effectiveAt: new Date().toISOString(),
          lastReviewedAt: new Date().toISOString(),
          reviewedBy: 'owner',
          reviewNotes: null,
          productionApprovedBy: null,
          productionApprovedAt: null,
          productionApprovalNote: null,
          createdAt: new Date().toISOString(),
        },
      ]),
      robotsAllowed: false,
    });

    const result = await worker.discover(target);

    expect(result).toMatchObject({ blocked: true, targetsRecorded: 0 });
    expect(result.note).toMatch(/robots.txt disallows/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function createWorker(options: {
  fetch: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  sourcePolicy?: SourcePolicyRegistry;
  robotsAllowed?: boolean;
}): DiscoveryWorker {
  const fetcher = { fetch: options.fetch } as unknown as Fetcher;
  const robots: RobotsProvider = {
    check: vi.fn().mockResolvedValue({
      allowed: options.robotsAllowed ?? true,
      matchedRule: options.robotsAllowed === false ? '/' : null,
      crawlDelaySeconds: null,
      note: 'test decision',
    }),
  };
  return new DiscoveryWorker({
    client: { query: options.query } as SqlClient,
    fetcher,
    robots,
    adapters: new AdapterRegistry(),
    logger: createSilentLogger(),
    vocabulary,
    sourcePolicy: options.sourcePolicy,
  });
}
