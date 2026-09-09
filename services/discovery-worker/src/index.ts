import {
  CrawlEngine,
  canonicalizeUrl,
  domainOf,
  isExcludedUrl,
  isAllowedDomain,
  scoreDirectoryUrl,
  urlHash,
  withPolicyDefaults,
  websiteSitemapUrl,
  SourcePolicyRegistry,
  type CollectionMode,
  type CrawlPolicy,
} from '@public-workforce/core';
import { loadHtml } from '@public-workforce/extraction';
import type {
  DirectoryVocabulary,
  Fetcher,
  RobotsProvider,
  Uuid,
} from '@public-workforce/shared-types';
import type { Logger } from '@public-workforce/observability';
import type { AdapterRegistry } from '@public-workforce/adapter-kit';
import { IngestionRepository, type SqlClient } from '@public-workforce/database';

export interface DiscoveryTarget {
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
export interface DiscoveryState {
  pending: { url: string; depth: number }[];
  visited: string[];
  candidates: DiscoveredCandidate[];
  pagesProcessed: number;
}
export interface DiscoverySummary {
  siteUrl: string;
  candidates: DiscoveredCandidate[];
  targetsRecorded: number;
  unsupportedPlatform: boolean;
  note: string | null;
  blocked: boolean;
  outcome: 'completed' | 'policy_hold' | 'blocked' | 'failed';
  pagesProcessed: number;
  retryable: boolean;
  partial: boolean;
}

/** Navigation discovery must work before a homepage qualifies as a directory. */
export class DiscoveryWorker {
  constructor(
    private readonly deps: {
      client: SqlClient;
      fetcher: Fetcher;
      robots: RobotsProvider;
      adapters: AdapterRegistry;
      logger: Logger;
      vocabulary: DirectoryVocabulary;
      policy?: Partial<CrawlPolicy>;
      collectionMode?: CollectionMode;
      sourcePolicy?: SourcePolicyRegistry;
      sleep?: (ms: number) => Promise<void>;
      resumeFrom?: DiscoveryState;
      onCheckpoint?: (state: DiscoveryState) => Promise<void>;
      assertActive?: () => Promise<void>;
    },
  ) {}

  async discover(target: DiscoveryTarget): Promise<DiscoverySummary> {
    const seed = canonicalizeUrl(target.siteUrl);
    const state: DiscoveryState = this.deps.resumeFrom ?? {
      pending:
        seed === null
          ? []
          : [
              { url: seed, depth: 0 },
              {
                url:
                  this.deps.policy?.websiteScope === undefined
                    ? new URL('/sitemap.xml', seed).href
                    : websiteSitemapUrl(this.deps.policy.websiteScope.websiteUrl),
                depth: 0,
              },
            ],
      visited: [],
      candidates: [],
      pagesProcessed: 0,
    };
    const summary = (
      outcome: DiscoverySummary['outcome'],
      note: string | null,
      retryable = false,
    ): DiscoverySummary => ({
      siteUrl: seed ?? target.siteUrl,
      candidates: state.candidates,
      targetsRecorded: state.candidates.length,
      unsupportedPlatform: false,
      blocked: outcome === 'blocked' || outcome === 'policy_hold',
      outcome,
      note,
      pagesProcessed: state.pagesProcessed,
      retryable,
      partial: state.pending.length > 0,
    });
    if (seed === null) return summary('failed', 'unusable site url');
    const policy = withPolicyDefaults({ maxPagesPerRun: 25, maxDepth: 3, ...this.deps.policy });
    const mode = this.deps.collectionMode ?? 'production';
    const registry = this.deps.sourcePolicy ?? SourcePolicyRegistry.empty();
    let requests = 0;
    let failures = 0;
    let lastFailure: string | null = null;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (state.pending.length > 0 && state.pagesProcessed < policy.maxPagesPerRun) {
      await this.deps.assertActive?.();
      const task = state.pending[0];
      if (task === undefined) break;
      if (
        state.visited.includes(task.url) ||
        task.depth > policy.maxDepth ||
        !isAllowedDomain(task.url, seed, policy) ||
        isExcludedUrl(task.url).excluded
      ) {
        state.pending.shift();
        continue;
      }
      const decision = registry.evaluate(task.url, mode);
      if (!decision.allowed) {
        if (task.url === seed) {
          await this.recordBlocked(target, seed, 'policy_hold', decision.reason);
          return summary('policy_hold', decision.reason);
        }
        state.pending.shift();
        lastFailure = decision.reason;
        failures++;
        continue;
      }
      const robots = policy.respectRobots
        ? await this.deps.robots.check(task.url, policy.userAgent)
        : null;
      if (robots !== null && !robots.allowed) {
        const reason = `robots.txt disallows discovery${robots.matchedRule === null ? '' : ` by ${robots.matchedRule}`}`;
        if (task.url === seed) {
          await this.recordBlocked(target, seed, 'blocked', reason);
          return summary('blocked', reason);
        }
        state.pending.shift();
        failures++;
        lastFailure = reason;
        continue;
      }
      if (requests > 0)
        await sleep(Math.max(policy.requestDelayMs, (robots?.crawlDelaySeconds ?? 0) * 1000));
      requests++;
      const result = await this.deps.fetcher.fetch({
        url: task.url,
        timeoutMs: policy.requestTimeoutMs,
      });
      await this.deps.assertActive?.();
      if (!result.ok) {
        if (task.url === seed || result.failure.retryable) {
          const blocked = ['blocked_by_source', 'requires_authentication'].includes(
            result.failure.errorType,
          );
          if (blocked)
            await this.recordBlocked(target, task.url, 'blocked', result.failure.message);
          return summary(
            blocked ? 'blocked' : 'failed',
            result.failure.message,
            result.failure.retryable,
          );
        }
        state.pending.shift();
        state.visited.push(task.url);
        // Missing sitemap is an exhausted navigation option, not a failed directory.
        if (!(
          new URL(task.url).pathname.endsWith('/sitemap.xml') && result.failure.status === 404
        )) {
          failures++;
          lastFailure = result.failure.message;
        }
        await this.deps.onCheckpoint?.(state);
        continue;
      }
      const page = result.page;
      if (!isAllowedDomain(page.finalUrl, seed, policy)) {
        state.pending.shift();
        state.visited.push(task.url);
        failures++;
        lastFailure = 'redirect left the organization website';
        await this.deps.onCheckpoint?.(state);
        continue;
      }
      if (mode === 'production' && page.storageKey == null)
        throw new Error('production discovery response was not archived; refusing to inspect it');
      const document = await new IngestionRepository(this.deps.client).recordSourceDocument({
        url: page.finalUrl,
        urlCanonical: page.finalUrl,
        urlHash: urlHash(page.finalUrl),
        domain: domainOf(page.finalUrl) ?? 'unknown',
        sourceTypeCode: 'html_directory',
        httpStatus: page.status,
        contentHash: page.contentHash,
        contentType: page.contentType,
        storageKey: page.storageKey ?? null,
        robotsAllowed: robots?.allowed ?? null,
        robotsPolicyNote: robots === null ? null : (robots.note ?? robots.matchedRule),
        sourcePolicyId: decision.policyId,
        crawlRunId: null,
        retrievedAt: page.fetchedAt,
      });
      state.pagesProcessed++;
      if (
        /(g-recaptcha|hcaptcha|cf-challenge|challenge-platform|verify you are human)/i.test(
          page.body,
        )
      ) {
        await this.recordBlocked(target, task.url, 'blocked', 'source requires human verification');
        return summary('blocked', 'source requires human verification');
      }
      const context = {
        baseUrl: page.finalUrl,
        organizationName: target.organizationName,
        parentOrganizationName: target.parentOrganizationName,
        allowedDomains: policy.allowedDomains,
        vocabulary: this.deps.vocabulary,
        now: () => new Date(),
      };
      const selection = this.deps.adapters.trySelect({
        url: page.finalUrl,
        page,
        hints: {},
        vocabulary: this.deps.vocabulary,
      });
      if (selection !== null) {
        const listing = selection.adapter.extractListing(page, context);
        if (listing.records.length > 0 || listing.pagination.requests.length > 0) {
          const candidate = {
            url: page.finalUrl,
            score: selection.detection.score,
            adapterKey: selection.adapter.key,
            reasons: selection.detection.reasons,
          };
          await this.recordTarget(target, candidate, document.documentId);
          if (!state.candidates.some((c) => c.url === candidate.url))
            state.candidates.push(candidate);
        }
      }
      const links = this.deps.adapters
        .list()
        .flatMap((adapter) => adapter.discoverDirectories(page, context));
      const $ = loadHtml(page.body);
      $('nav a[href], header a[href], footer a[href], a[href]').each((_index, element) => {
        const href = $(element).attr('href');
        if (href === undefined) return;
        let url: string;
        try {
          url = new URL(href, page.finalUrl).href;
        } catch {
          return;
        }
        if (
          /about|contact|department|directory|personnel|staff|sitemap/i.test(
            `${href} ${$(element).text()}`,
          )
        ) {
          links.push({
            url,
            score: 0.2,
            reasons: ['navigation link'],
            targetType: 'organization_site',
            sourceTypeCode: 'html_directory',
          });
        }
      });
      $('loc').each((_index, element) => {
        const url = $(element).text().trim();
        const score = scoreDirectoryUrl(url, this.deps.vocabulary.urlHints).score;
        if (score > 0 || /sitemap[^/]*\.xml/i.test(url))
          links.push({
            url,
            score,
            reasons: ['sitemap entry'],
            targetType: 'organization_site',
            sourceTypeCode: 'html_directory',
          });
      });
      state.pending.shift();
      state.visited.push(task.url);
      for (const link of links.sort((a, b) => b.score - a.score)) {
        const url = canonicalizeUrl(link.url);
        if (
          url !== null &&
          isAllowedDomain(url, seed, policy) &&
          !state.visited.includes(url) &&
          !state.pending.some((item) => item.url === url) &&
          state.pending.length < 10000
        ) {
          state.pending.push({ url, depth: task.depth + 1 });
        }
      }
      await this.deps.onCheckpoint?.(state);
      if (failures >= policy.maxConsecutiveFailuresPerDomain) break;
    }
    const partial = state.pending.length > 0 || failures > 0;
    const result = summary(
      'completed',
      partial
        ? `discovery incomplete: ${lastFailure ?? 'page or depth budget reached'}`
        : state.candidates.length === 0
          ? 'no directory found in the inspected navigation'
          : null,
    );
    result.partial = partial;
    return result;
  }

  private async recordTarget(
    target: DiscoveryTarget,
    candidate: DiscoveredCandidate,
    sourceDocumentId: Uuid,
  ): Promise<void> {
    const result = await this.deps.client.query<{ id: Uuid }>(
      `insert into crawl_targets (organization_id, jurisdiction_id, url, url_hash, target_type, source_type_code, adapter_key, status, priority)
       values ($1,$2,$3,$4,'organization_directory','html_directory',$5,'ready',$6)
       on conflict (url_hash) do update set adapter_key=excluded.adapter_key,
         target_type='organization_directory', status=case when crawl_targets.status='crawled' then crawl_targets.status else excluded.status end,
         priority=excluded.priority, updated_at=now() returning id`,
      [
        target.organizationId,
        target.jurisdictionId,
        candidate.url,
        urlHash(candidate.url),
        candidate.adapterKey,
        Math.round((1 - candidate.score) * 100),
      ],
    );
    const id = result.rows[0]?.id;
    if (id !== undefined)
      await this.deps.client.query(
        `insert into crawl_target_organizations (crawl_target_id,organization_id,source_document_id)
       values ($1,$2,$3) on conflict do nothing`,
        [id, target.organizationId, sourceDocumentId],
      );
  }
  private async recordBlocked(
    target: DiscoveryTarget,
    url: string,
    status: 'blocked' | 'policy_hold',
    reason: string,
  ): Promise<void> {
    await this.deps.client.query(
      `insert into crawl_targets (organization_id,jurisdiction_id,url,url_hash,target_type,source_type_code,status,exclusion_reason)
       values ($1,$2,$3,$4,'organization_site','html_directory',$5,$6)
       on conflict (url_hash) do update set status=excluded.status,exclusion_reason=excluded.exclusion_reason,updated_at=now()`,
      [target.organizationId, target.jurisdictionId, url, urlHash(url), status, reason],
    );
  }
}
export { CrawlEngine };
