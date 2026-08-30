import {
  generateCandidate,
  learnDomainPatterns,
  parsePersonName,
  type LearnedPattern,
  type PublishedNamePair,
} from '@pan/core';
import type { Uuid } from '@pan/shared-types';
import type { Logger } from '@pan/observability';
import type { QueryRepository, SqlClient } from '@pan/database';

export interface CandidateGenerationOptions {
  /** Minimum published examples before a domain's pattern may be used. */
  minSupport?: number;
  minConsistency?: number;
  /** Cap per run, so a first run on a large state cannot balloon. */
  maxCandidates?: number;
}

export interface CandidateGenerationSummary {
  domainsExamined: number;
  patternsLearned: number;
  candidatesCreated: number;
  peopleSkippedNoPattern: number;
  peopleSkippedHasPublished: number;
}

/**
 * Generates inferred addresses as a separate asynchronous pass.
 *
 * Deliberately not part of crawling or ingestion. Keeping inference in its own
 * job is what makes "this is what the page said" and "this is what we guessed"
 * impossible to confuse: nothing this class writes ever lands in
 * `email_addresses`, and every row it creates carries the pattern and the
 * published examples that justified it.
 */
export class CandidateGenerator {
  constructor(
    private readonly deps: { client: SqlClient; queries: QueryRepository; logger: Logger },
  ) {}

  /**
   * Generate candidates for every domain in scope.
   *
   * Scope is an organization filter, not a state: a federal agency has no state,
   * and a county department is not reached by naming one.
   */
  async generateForScope(
    scope: { governmentLevelCode?: string; sectorCode?: string } = {},
    options: CandidateGenerationOptions = {},
  ): Promise<CandidateGenerationSummary> {
    const summary: CandidateGenerationSummary = {
      domainsExamined: 0,
      patternsLearned: 0,
      candidatesCreated: 0,
      peopleSkippedNoPattern: 0,
      peopleSkippedHasPublished: 0,
    };
    const maxCandidates = options.maxCandidates ?? 10_000;

    const domains = await this.deps.client.query<{ domain: string }>(
      `select distinct e.domain
       from email_addresses e
       join organizations o on o.id = e.organization_id
       where e.classification in ('published','decoded_published')
         and ($1::text is null or o.government_level_code = $1)
         and ($2::text is null or o.sector_code = $2)`,
      [scope.governmentLevelCode ?? null, scope.sectorCode ?? null],
    );

    for (const { domain } of domains.rows) {
      summary.domainsExamined += 1;
      const learned = await this.learnForDomain(domain, options);
      if (learned === null) continue;
      summary.patternsLearned += 1;

      await this.deps.client.query(
        `insert into domain_email_patterns (domain, pattern, supporting_examples, support_count, conflict_count, consistency)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (domain, pattern) do update set
           supporting_examples = excluded.supporting_examples,
           support_count = excluded.support_count,
           conflict_count = excluded.conflict_count,
           consistency = excluded.consistency,
           learned_at = now()`,
        [
          learned.domain,
          learned.pattern,
          JSON.stringify(learned.supportingExamples),
          learned.supportCount,
          learned.conflictCount,
          learned.consistency,
        ],
      );

      // Only people with no observed address at all get a candidate. Guessing
      // an address for someone whose real one is published would be pointless
      // and would risk the guess being mistaken for the published value.
      // Only people with no observed address at all get a candidate. Guessing
      // for someone whose real address is published would be pointless and
      // would risk the guess being mistaken for the published value.
      const targets = await this.deps.client.query<{
        id: Uuid;
        full_name_published: string;
        organization_id: Uuid;
      }>(
        `select p.id, p.full_name_published, emp.organization_id
         from people p
         join employment_assignments emp on emp.person_id = p.id
         join organizations o on o.id = emp.organization_id
         where not exists (select 1 from email_addresses e where e.person_id = p.id)
           and (o.primary_domain = $1 or $1 = any(o.email_domains))
         group by p.id, p.full_name_published, emp.organization_id`,
        [domain],
      );

      for (const target of targets.rows) {
        if (summary.candidatesCreated >= maxCandidates) break;
        const candidate = generateCandidate(parsePersonName(target.full_name_published), learned);
        if (candidate === null) {
          summary.peopleSkippedNoPattern += 1;
          continue;
        }
        await this.deps.client.query(
          `insert into email_candidates (
             person_id, organization_id, domain, address, pattern, supporting_examples,
             support_count, conflict_count, consistency, confidence, state
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
           on conflict (person_id, address) do update set
             pattern = excluded.pattern,
             supporting_examples = excluded.supporting_examples,
             support_count = excluded.support_count,
             conflict_count = excluded.conflict_count,
             consistency = excluded.consistency,
             confidence = excluded.confidence,
             updated_at = now()`,
          [
            target.id,
            candidate.domain,
            candidate.address,
            candidate.pattern,
            JSON.stringify(candidate.evidence.supportingExamples),
            candidate.evidence.supportCount,
            candidate.evidence.conflictCount,
            candidate.evidence.consistency,
            candidate.confidence,
          ],
        );
        summary.candidatesCreated += 1;
      }
    }

    this.deps.logger.info({ ...scope, ...summary }, 'candidate generation complete');
    return summary;
  }

  private async learnForDomain(
    domain: string,
    options: CandidateGenerationOptions,
  ): Promise<LearnedPattern | null> {
    const published = await this.deps.queries.publishedPairsForDomain(domain);
    const pairs: PublishedNamePair[] = published.map((row) => ({
      parsed: parsePersonName(row.fullNamePublished),
      address: row.address,
    }));
    const learned = learnDomainPatterns(domain, pairs, {
      ...(options.minSupport === undefined ? {} : { minSupport: options.minSupport }),
      ...(options.minConsistency === undefined ? {} : { minConsistency: options.minConsistency }),
    });
    return learned[0] ?? null;
  }
}
