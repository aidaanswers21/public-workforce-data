import type { RobotsDecision, RobotsProvider } from '@public-workforce/shared-types';
import { DEFAULT_URL_EXCLUSION_PATTERNS, registrableDomain } from '../normalize/urls.js';

/**
 * Operational limits for one crawl run.
 *
 * Defaults are deliberately conservative. These are the knobs that decide
 * whether the crawler is a polite reader of public pages or a nuisance, so they
 * are configuration rather than constants, and every one of them is enforced by
 * the engine rather than left to adapters.
 */
export interface CrawlPolicy {
  /** Identifies us and points at a page explaining the crawl and how to opt out. */
  userAgent: string;
  contactUrl: string;
  maxPagesPerRun: number;
  maxPagesPerDomain: number;
  maxDepth: number;
  /** Minimum gap between two requests to the same domain. */
  requestDelayMs: number;
  maxConcurrencyPerDomain: number;
  /** Abort a domain after this many consecutive failures. */
  maxConsecutiveFailuresPerDomain: number;
  /** Stop paginating after this many pages that add no new records. */
  maxPagesWithoutNewRecords: number;
  respectRobots: boolean;
  /**
   * Registrable domains the run may touch. Empty means "the seed's domain only",
   * which is the safe default: a directory link should never walk us onto an
   * unrelated site.
   */
  allowedDomains: readonly string[];
  excludedUrlPatterns: readonly RegExp[];
  /**
   * DNS labels used by United States locality domains, from the taxonomy.
   *
   * Without them `co.harris.tx.us` and `ci.austin.tx.us` both collapse to
   * `tx.us`, and every public body in a state looks like one site.
   */
  localityDomainLabels: readonly string[];
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_CRAWL_POLICY: CrawlPolicy = {
  userAgent:
    'PublicWorkforceDataBot/0.1 (+https://example.invalid/crawler-policy; contact configured per deployment)',
  contactUrl: 'https://example.invalid/crawler-policy',
  maxPagesPerRun: 250,
  maxPagesPerDomain: 250,
  maxDepth: 4,
  requestDelayMs: 1500,
  maxConcurrencyPerDomain: 1,
  maxConsecutiveFailuresPerDomain: 5,
  maxPagesWithoutNewRecords: 3,
  respectRobots: true,
  allowedDomains: [],
  excludedUrlPatterns: DEFAULT_URL_EXCLUSION_PATTERNS,
  localityDomainLabels: [],
  maxRetries: 2,
  retryBaseDelayMs: 500,
  requestTimeoutMs: 20_000,
};

export function withPolicyDefaults(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return { ...DEFAULT_CRAWL_POLICY, ...overrides };
}

/** True when `url` is on a domain this run is permitted to fetch. */
export function isAllowedDomain(url: string, seedUrl: string, policy: CrawlPolicy): boolean {
  let host: string;
  let seedHost: string;
  try {
    host = registrableDomain(new URL(url).hostname, policy.localityDomainLabels);
    seedHost = registrableDomain(new URL(seedUrl).hostname, policy.localityDomainLabels);
  } catch {
    return false;
  }
  if (policy.allowedDomains.length === 0) return host === seedHost;
  return policy.allowedDomains.some(
    (allowed) => registrableDomain(allowed, policy.localityDomainLabels) === host,
  );
}

/**
 * robots.txt parser covering the directives that matter for a polite crawler:
 * User-agent grouping, Allow, Disallow and Crawl-delay. Longest-match wins, and
 * an explicit Allow beats an equally specific Disallow, per the usual convention.
 */
export class RobotsTxt {
  private constructor(
    private readonly groups: ReadonlyMap<
      string,
      { allow: string[]; disallow: string[]; crawlDelay: number | null }
    >,
  ) {}

  static parse(content: string): RobotsTxt {
    const groups = new Map<
      string,
      { allow: string[]; disallow: string[]; crawlDelay: number | null }
    >();
    let currentAgents: string[] = [];
    let sawDirective = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.split('#')[0]?.trim() ?? '';
      if (line.length === 0) continue;
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (field === 'user-agent') {
        if (sawDirective) {
          currentAgents = [];
          sawDirective = false;
        }
        currentAgents.push(value.toLowerCase());
        if (!groups.has(value.toLowerCase())) {
          groups.set(value.toLowerCase(), { allow: [], disallow: [], crawlDelay: null });
        }
        continue;
      }

      if (currentAgents.length === 0) continue;
      sawDirective = true;
      for (const agent of currentAgents) {
        const group = groups.get(agent);
        if (group === undefined) continue;
        if (field === 'disallow' && value.length > 0) group.disallow.push(value);
        else if (field === 'allow' && value.length > 0) group.allow.push(value);
        else if (field === 'crawl-delay') {
          const parsed = Number.parseFloat(value);
          if (Number.isFinite(parsed)) group.crawlDelay = parsed;
        }
      }
    }
    return new RobotsTxt(groups);
  }

  check(path: string, userAgent: string): RobotsDecision {
    const agentToken = userAgent.split('/')[0]?.toLowerCase() ?? userAgent.toLowerCase();
    const group = this.groups.get(agentToken) ?? this.groups.get('*');
    if (group === undefined) {
      return {
        allowed: true,
        matchedRule: null,
        crawlDelaySeconds: null,
        note: 'no matching group',
      };
    }

    const longestAllow = longestMatch(group.allow, path);
    const longestDisallow = longestMatch(group.disallow, path);

    if (longestDisallow === null) {
      return {
        allowed: true,
        matchedRule: longestAllow,
        crawlDelaySeconds: group.crawlDelay,
        note: null,
      };
    }
    if (longestAllow !== null && longestAllow.length >= longestDisallow.length) {
      return {
        allowed: true,
        matchedRule: `Allow: ${longestAllow}`,
        crawlDelaySeconds: group.crawlDelay,
        note: 'explicit allow overrides disallow',
      };
    }
    return {
      allowed: false,
      matchedRule: `Disallow: ${longestDisallow}`,
      crawlDelaySeconds: group.crawlDelay,
      note: null,
    };
  }
}

function longestMatch(rules: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const rule of rules) {
    if (!matchesRule(rule, path)) continue;
    if (best === null || rule.length > best.length) best = rule;
  }
  return best;
}

/** Supports the `*` wildcard and the `$` end-anchor. */
function matchesRule(rule: string, path: string): boolean {
  if (!rule.includes('*') && !rule.endsWith('$')) return path.startsWith(rule);
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const pattern = body
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

/**
 * Fetches and caches robots.txt per origin.
 *
 * The default follows the usual permissive convention for compatibility.
 * Production callers select fail-closed behaviour, and the outcome is recorded
 * either way so the policy log shows what we observed and how it was handled.
 */
export class HttpRobotsProvider implements RobotsProvider {
  private readonly cache = new Map<string, RobotsTxt | null>();

  constructor(
    private readonly fetchText: (
      url: string,
    ) => Promise<{ ok: boolean; status: number; body: string }>,
    private readonly options: { unavailablePolicy?: 'allow' | 'deny' } = {},
  ) {}

  async check(url: string, userAgent: string): Promise<RobotsDecision> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        allowed: false,
        matchedRule: null,
        crawlDelaySeconds: null,
        note: 'unparseable url',
      };
    }
    const origin = parsed.origin;
    let robots = this.cache.get(origin);
    if (robots === undefined) {
      const response = await this.fetchText(`${origin}/robots.txt`);
      robots = response.ok && response.body.length > 0 ? RobotsTxt.parse(response.body) : null;
      this.cache.set(origin, robots);
    }
    if (robots === null) {
      const allowed = this.options.unavailablePolicy !== 'deny';
      return {
        allowed,
        matchedRule: null,
        crawlDelaySeconds: null,
        note: allowed
          ? 'robots.txt unavailable, treated as permissive'
          : 'robots.txt unavailable, production policy refuses collection',
      };
    }
    return robots.check(parsed.pathname + parsed.search, userAgent);
  }
}

/** Always allows. Used only in fixture runs, where nothing is actually fetched. */
export class PermissiveRobotsProvider implements RobotsProvider {
  check(): Promise<RobotsDecision> {
    return Promise.resolve({
      allowed: true,
      matchedRule: null,
      crawlDelaySeconds: null,
      note: 'fixture run, no network access',
    });
  }
}
