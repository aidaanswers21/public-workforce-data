import type { CrawlRunResult, HarvestedRecord } from '@pan/core';
import {
  classifyEmail,
  domainOf,
  isOrganizationLabel,
  normalizeDepartmentName,
  normalizeTitle,
  nowTimestamp,
  parsePersonName,
  personIdentityKey,
  urlHash,
  type Clock,
} from '@pan/core';
import type { EmailClassification, SourceType, Uuid } from '@pan/shared-types';
import type { Logger } from '@pan/observability';
import type { CrawlRepository, IngestionRepository } from '@pan/database';
import { type IngestEmailInput } from '@pan/database';

export interface IngestContext {
  stateId: Uuid;
  stateCode: string;
  districtId: Uuid | null;
  schoolId: Uuid | null;
  districtName: string | null;
  sourceType: SourceType;
}

export interface IngestSummary {
  pages: number;
  peopleCreated: number;
  peopleSeen: number;
  publishedEmails: number;
  decodedEmails: number;
  generalInboxes: number;
  invalidEmails: number;
  observations: number;
  errors: number;
}

type ObservedClassification = IngestEmailInput['classification'];

const OBSERVED: readonly EmailClassification[] = [
  'published',
  'decoded_published',
  'general_inbox',
  'invalid',
];

/**
 * Turns crawl output into normalized, provenance-carrying rows.
 *
 * Everything the adapter published verbatim is written to `source_observations`
 * before the normalized record is written, so a value can always be traced back
 * to the exact string on the exact page. Inference happens nowhere in this file:
 * candidate generation is a separate pass in the validation worker, which is
 * what keeps "what a source said" and "what we guessed" structurally apart.
 */
export class IngestionPipeline {
  constructor(
    private readonly deps: {
      ingestion: IngestionRepository;
      crawl: CrawlRepository;
      logger: Logger;
      clock?: Clock;
    },
  ) {}

  async ingestRun(result: CrawlRunResult, context: IngestContext): Promise<IngestSummary> {
    const clock = this.deps.clock;
    const summary: IngestSummary = {
      pages: result.pages.length,
      peopleCreated: 0,
      peopleSeen: 0,
      publishedEmails: 0,
      decodedEmails: 0,
      generalInboxes: 0,
      invalidEmails: 0,
      observations: 0,
      errors: result.errors.length,
    };

    for (const page of result.pages) await this.deps.crawl.upsertPage(page);
    for (const error of result.errors) await this.deps.crawl.recordError(error);

    const sourcePageIds = new Map<string, Uuid>();

    for (const harvested of result.records) {
      const sourcePageId = await this.resolveSourcePage(
        harvested,
        result.crawlRunId,
        context,
        sourcePageIds,
      );
      const ingested = await this.ingestOne(
        harvested,
        sourcePageId,
        result.crawlRunId,
        context,
        summary,
      );
      summary.peopleSeen += 1;
      if (ingested) summary.peopleCreated += 1;
    }

    await this.deps.crawl.saveCheckpoint(result.checkpoint);
    this.deps.logger.info(
      { crawlRunId: result.crawlRunId, ...summary, at: nowTimestamp(clock) },
      'ingested crawl output',
    );
    return summary;
  }

  private async resolveSourcePage(
    harvested: HarvestedRecord,
    crawlRunId: Uuid,
    context: IngestContext,
    cache: Map<string, Uuid>,
  ): Promise<Uuid> {
    const cached = cache.get(harvested.sourceUrl);
    if (cached !== undefined) return cached;

    const sourcePageId = await this.deps.ingestion.upsertSourcePage({
      url: harvested.sourceUrl,
      urlCanonical: harvested.sourceUrl,
      urlHash: urlHash(harvested.sourceUrl),
      domain: domainOf(harvested.sourceUrl) ?? 'unknown',
      sourceType: context.sourceType,
      httpStatus: 200,
      contentHash: harvested.sourceContentHash,
      contentType: 'text/html',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: null,
      crawlRunId,
      fetchedAt: harvested.fetchedAt,
    });
    cache.set(harvested.sourceUrl, sourcePageId);
    return sourcePageId;
  }

  private async ingestOne(
    harvested: HarvestedRecord,
    sourcePageId: Uuid,
    crawlRunId: Uuid,
    context: IngestContext,
    summary: IngestSummary,
  ): Promise<boolean> {
    const record = harvested.record;
    const parsed = parsePersonName(record.fullNamePublished);
    const title = normalizeTitle(record.titlePublished);
    // An organization label must never vouch for a role inbox as personal.
    const nameForClassification = isOrganizationLabel(record.fullNamePublished) ? null : parsed;

    const emails: IngestEmailInput[] = [];
    for (const email of record.emails) {
      const classification = classifyEmail({
        address: email.address,
        obfuscation: email.obfuscation,
        origin: 'observed',
        personName: nameForClassification,
      });
      if (!OBSERVED.includes(classification.classification)) continue;

      const [localPart, domain] = email.address.split('@');
      emails.push({
        address: email.address,
        addressNormalized: email.address.toLowerCase(),
        domain: domain ?? '',
        localPart: localPart ?? '',
        classification: classification.classification as ObservedClassification,
        obfuscation: email.obfuscation,
        sourceValue: email.raw,
      });

      if (classification.classification === 'published') summary.publishedEmails += 1;
      else if (classification.classification === 'decoded_published') summary.decodedEmails += 1;
      else if (classification.classification === 'general_inbox') summary.generalInboxes += 1;
      else summary.invalidEmails += 1;
    }

    const orgScopeId = context.schoolId ?? context.districtId ?? context.stateId;
    const identityKey = personIdentityKey({ stateCode: context.stateCode, orgScopeId, parsed });

    const result = await this.deps.ingestion.ingestPerson({
      recordKey: record.recordKey,
      stateId: context.stateId,
      districtId: context.districtId,
      schoolId: context.schoolId,
      departmentId: null,
      fullNamePublished: record.fullNamePublished,
      nameParts: parsed,
      identityKey,
      titlePublished: record.titlePublished,
      titleNormalized: title.titleNormalized.length > 0 ? title.titleNormalized : null,
      roleCategory: title.roleCategory,
      seniority: title.seniority,
      specialty: title.specialty,
      emails,
      sourcePageId,
      crawlRunId,
      extractionMethod: record.extractionMethod,
      confidence: record.confidence,
      observedAt: harvested.fetchedAt,
    });

    await this.recordObservations(harvested, sourcePageId, crawlRunId, result.personId, summary);
    return result.personCreated;
  }

  /** One row per published field, so nothing normalized is untraceable. */
  private async recordObservations(
    harvested: HarvestedRecord,
    sourcePageId: Uuid,
    crawlRunId: Uuid,
    personId: Uuid,
    summary: IngestSummary,
  ): Promise<void> {
    const record = harvested.record;
    const fields: readonly [string, string | null, string | null][] = [
      [
        'full_name_published',
        record.fullNamePublished,
        parsePersonName(record.fullNamePublished).displayName,
      ],
      [
        'title_published',
        record.titlePublished,
        normalizeTitle(record.titlePublished).titleNormalized || null,
      ],
      [
        'department_published',
        record.departmentPublished,
        record.departmentPublished === null
          ? null
          : normalizeDepartmentName(record.departmentPublished),
      ],
      ['school_published', record.schoolPublished, record.schoolPublished],
      ['phone_published', record.phonePublished, record.phonePublished],
      ...record.emails.map(
        (email) =>
          ['email_published', email.raw, email.address] as [string, string | null, string | null],
      ),
    ];

    for (const [field, valueRaw, valueNormalized] of fields) {
      if (valueRaw === null) continue;
      await this.deps.ingestion.recordObservation({
        sourcePageId,
        crawlRunId,
        entityType: 'person',
        entityId: personId,
        recordKey: record.recordKey,
        field:
          field === 'email_published' ? `email_published:${valueNormalized ?? valueRaw}` : field,
        valueRaw,
        valueNormalized,
        extractionMethod: record.extractionMethod,
        confidence: record.confidence,
        selector: record.selector,
        observedAt: harvested.fetchedAt,
      });
      summary.observations += 1;
    }
  }
}
