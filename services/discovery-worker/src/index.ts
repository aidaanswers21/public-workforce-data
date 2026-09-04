import {
  CrawlEngine,
  canonicalizeUrl,
  isExcludedUrl,
  scoreDirectoryUrl,
  urlHash,
  withPolicyDefaults,
  SourcePolicyRegistry,
  type CollectionMode,
  type CrawlPolicy,
} from '@public-workforce/core';
import type {
  DirectoryVocabulary,
  Fetcher,
  RobotsProvider,
  Uuid,
} from '@public-workforce/shared-types';
import type { Logger } from '@public-workforce/observability';
import type { AdapterRegistry } from '@public-workforce/adapter-kit';
import { UnsupportedPlatformError } from '@public-workforce/adapter-kit';
import type { SqlClient } from '@public-workforce/database';

export interface DiscoveryTarget {
  /** The organization whose site this is. Any public body, at any level. */
  organizationId: Uuid;
  jurisdictionId: Uuid | null;
  siteUrl: string;
  organizationName: string | null;
  parentOrganizationName: string | null;
}

export interface DiscoveredCandidate {
  url: string;
  score: number;
  adapterKey: string | null;
  reasons: readonly string[];
}

export interface DiscoverySummary {
  siteUrl: string;
  candidates: DiscoveredCandidate[];
  targetsRecorded: number;
  unsupportedPlatform: boolean;
  note: string | null;
  blocked: boolean;
}

/**
 * Finds an organization's staff directory and records it as a crawl target.
 *
 * Discovery is separated from crawling so that "we could not find a directory"
 * and "we found one and it broke" are different, countable outcomes. Coverage
 * reporting depends on that distinction: 900 organizations with 200 discovered
 * directories is a discovery problem, not an extraction one.
 */
export class DiscoveryWorker {
  constructor(
    private readonly deps: {
      client: SqlClient;
      fetcher: Fetcher;
      robots: RobotsProvider;
      adapters: AdapterRegistry;
      logger: Logger;
      /** Composed from the registered sectors. Never hard-coded here. */
      vocabulary: DirectoryVocabulary;
      policy?: Partial<CrawlPolicy>;
      collectionMode?: CollectionMode;
      sourcePolicy?: SourcePolicyRegistry;
    },
  ) {}

  async discover(target: DiscoveryTarget): Promise<DiscoverySummary> {
    const seed = canonicalizeUrl(target.siteUrl);
    if (seed === null) {
      return {
        siteUrl: target.siteUrl,
        candidates: [],
        targetsRecorded: 0,
        unsupportedPlatform: false,
        note: 'unusable site url',
        blocked: true,
      };
    }

    const policy = withPolicyDefaults({
      maxPagesPerRun: 5,
      maxDepth: 1,
      ...this.deps.policy,
    });

    const sourceDecision = (this.deps.sourcePolicy ?? SourcePolicyRegistry.empty()).evaluate(
      seed,
      this.deps.collectionMode ?? 'production',
    );
    if (!sourceDecision.allowed) {
      await this.recordBlocked(target, seed, 'policy_hold', sourceDecision.reason);
      return {
        siteUrl: seed,
        candidates: [],
        targetsRecorded: 0,
        unsupportedPlatform: false,
        note: sourceDecision.reason,
        blocked: true,
      };
    }

    if (policy.respectRobots) {
      const robots = await this.deps.robots.check(seed, policy.userAgent);
      if (!robots.allowed) {
        const note = `robots.txt disallows discovery${robots.matchedRule === null ? '' : ` by ${robots.matchedRule}`}`;
        await this.recordBlocked(target, seed, 'blocked', note);
        return {
          siteUrl: seed,
          candidates: [],
          targetsRecorded: 0,
          unsupportedPlatform: false,
          note,
          blocked: true,
        };
      }
    }

    const outcome = await this.deps.fetcher.fetch({
      url: seed,
      timeoutMs: policy.requestTimeoutMs,
    });
    if (!outcome.ok) {
      this.deps.logger.warn(
        { url: seed, failure: outcome.failure },
        'discovery could not fetch the site',
      );
      return {
        siteUrl: seed,
        candidates: [],
        targetsRecorded: 0,
        unsupportedPlatform: false,
        note: outcome.failure.message,
        blocked: false,
      };
    }

    const page = outcome.page;
    let selection;
    try {
      selection = this.deps.adapters.select({
        url: seed,
        page,
        hints: {},
        vocabulary: this.deps.vocabulary,
      });
    } catch (error) {
      if (error instanceof UnsupportedPlatformError) {
        await this.recordUnsupported(target, seed);
        return {
          siteUrl: seed,
          candidates: [],
          targetsRecorded: 0,
          unsupportedPlatform: true,
          note: 'no adapter claimed the site; recorded for platform review',
          blocked: false,
        };
      }
      throw error;
    }

    const discovered = selection.adapter.discoverDirectories(page, {
      baseUrl: page.finalUrl,
      organizationName: target.organizationName,
      parentOrganizationName: target.parentOrganizationName,
      allowedDomains: [],
      vocabulary: this.deps.vocabulary,
      now: () => new Date(),
    });

    const candidates: DiscoveredCandidate[] = [];
    for (const entry of discovered) {
      if (isExcludedUrl(entry.url).excluded) continue;
      const scored = scoreDirectoryUrl(entry.url, this.deps.vocabulary.urlHints);
      candidates.push({
        url: entry.url,
        score: Math.max(entry.score, scored.score),
        adapterKey: selection.adapter.key,
        reasons: [...entry.reasons, ...scored.reasons],
      });
    }
    candidates.sort((a, b) => b.score - a.score);

    let targetsRecorded = 0;
    for (const candidate of candidates.slice(0, 5)) {
      await this.recordTarget(target, candidate);
      targetsRecorded += 1;
    }

    return {
      siteUrl: seed,
      candidates,
      targetsRecorded,
      unsupportedPlatform: false,
      note: candidates.length === 0 ? 'no directory-looking links found on the site root' : null,
      blocked: false,
    };
  }

  private async recordTarget(
    target: DiscoveryTarget,
    candidate: DiscoveredCandidate,
  ): Promise<void> {
    await this.deps.client.query(
      `insert into crawl_targets (
         organization_id, jurisdiction_id, url, url_hash, target_type, source_type_code,
         adapter_key, status, priority
       ) values ($1,$2,$3,$4,'organization_directory','html_directory',$5,'ready',$6)
       on conflict (url_hash) do update set
         adapter_key = excluded.adapter_key,
         status = case when crawl_targets.status = 'crawled' then crawl_targets.status else excluded.status end,
         priority = excluded.priority,
         updated_at = now()`,
      [
        target.organizationId,
        target.jurisdictionId,
        candidate.url,
        urlHash(candidate.url),
        candidate.adapterKey,
        Math.round((1 - candidate.score) * 100),
      ],
    );
  }

  /**
   * Record a site no adapter claimed.
   *
   * Kept as a countable outcome rather than an error, because a real platform
   * appearing repeatedly is what justifies writing an adapter for it.
   */
  private async recordUnsupported(target: DiscoveryTarget, url: string): Promise<void> {
    await this.deps.client.query(
      `insert into crawl_targets (
         organization_id, jurisdiction_id, url, url_hash, target_type, source_type_code,
         status, exclusion_reason
       ) values ($1,$2,$3,$4,'organization_site','html_directory','unsupported_platform',
                 'no registered adapter claimed this site')
       on conflict (url_hash) do update set
         status = 'unsupported_platform', updated_at = now()`,
      [target.organizationId, target.jurisdictionId, url, urlHash(url)],
    );
  }

  private async recordBlocked(
    target: DiscoveryTarget,
    url: string,
    status: 'blocked' | 'policy_hold',
    reason: string,
  ): Promise<void> {
    await this.deps.client.query(
      `insert into crawl_targets (
         organization_id, jurisdiction_id, url, url_hash, target_type, source_type_code,
         status, exclusion_reason
       ) values ($1,$2,$3,$4,'organization_site','html_directory',$5,$6)
       on conflict (url_hash) do update set
         status = excluded.status, exclusion_reason = excluded.exclusion_reason, updated_at = now()`,
      [target.organizationId, target.jurisdictionId, url, urlHash(url), status, reason],
    );
  }
}

export { CrawlEngine };
