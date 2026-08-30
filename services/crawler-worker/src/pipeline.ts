import type { CrawlRunResult, HarvestedRecord, TitleRuleSet } from '@pan/core';
import {
  applyDataBoundary,
  classifyEmail,
  domainOf,
  isOrganizationLabel,
  isPersonalEmailDomain,
  normalizePhone,
  normalizeTitle,
  normalizeUnitName,
  nowTimestamp,
  parsePersonName,
  personIdentityKey,
  urlHash,
  type Clock,
} from '@pan/core';
import type { DirectoryVocabulary, EmailClassification, Uuid } from '@pan/shared-types';
import type { Logger } from '@pan/observability';
import type { CrawlRepository, IngestionRepository, OrganizationRepository } from '@pan/database';
import { type IngestContactPointInput, type IngestEmailInput } from '@pan/database';

/**
 * The organization a collection run belongs to.
 *
 * One organization id, whatever kind of public body it is. There is no state,
 * district or parent field here, because a federal bureau has none of those and
 * the pipeline must not care.
 */
export interface IngestContext {
  organizationId: Uuid;
  organizationName: string | null;
  governmentLevelCode: string;
  sectorCode: string;
  jurisdictionId: Uuid | null;
  /** Reference code from the taxonomy, e.g. `html_directory`. */
  sourceTypeCode: string;
  vocabulary: DirectoryVocabulary;
  titleRules: TitleRuleSet;
}

export interface IngestSummary {
  pages: number;
  peopleCreated: number;
  peopleSeen: number;
  publishedEmails: number;
  decodedEmails: number;
  generalInboxes: number;
  invalidEmails: number;
  contactPoints: number;
  observations: number;
  /** Addresses dropped because they are personal rather than professional. */
  personalEmailsDropped: number;
  /** Values dropped by the public professional data boundary. */
  boundaryDrops: number;
  errors: number;
}

const OBSERVED: readonly EmailClassification[] = [
  'published',
  'decoded_published',
  'general_inbox',
  'invalid',
];

/**
 * Turns crawl output into normalized, provenance-carrying rows.
 *
 * Everything an adapter published verbatim is written to `source_observations`
 * before the normalized record, so a value can always be traced back to the
 * exact string on the exact document. Inference happens nowhere here: candidate
 * generation is a separate pass, which is what keeps "what a source said" and
 * "what we guessed" structurally apart.
 */
export class IngestionPipeline {
  constructor(
    private readonly deps: {
      ingestion: IngestionRepository;
      crawl: CrawlRepository;
      organizations: OrganizationRepository;
      logger: Logger;
      clock?: Clock;
    },
  ) {}

  async ingestRun(result: CrawlRunResult, context: IngestContext): Promise<IngestSummary> {
    const summary: IngestSummary = {
      pages: result.pages.length,
      peopleCreated: 0,
      peopleSeen: 0,
      publishedEmails: 0,
      decodedEmails: 0,
      generalInboxes: 0,
      invalidEmails: 0,
      contactPoints: 0,
      observations: 0,
      personalEmailsDropped: 0,
      boundaryDrops: 0,
      errors: result.errors.length,
    };

    for (const page of result.pages) await this.deps.crawl.upsertPage(page);
    for (const error of result.errors) await this.deps.crawl.recordError(error);

    const documentIds = new Map<string, Uuid>();

    for (const harvested of result.records) {
      const sourceDocumentId = await this.resolveDocument(
        harvested,
        result.crawlRunId,
        context,
        documentIds,
      );
      const created = await this.ingestOne(
        harvested,
        sourceDocumentId,
        result.crawlRunId,
        context,
        summary,
      );
      summary.peopleSeen += 1;
      if (created) summary.peopleCreated += 1;
    }

    await this.deps.crawl.saveCheckpoint(result.checkpoint);
    this.deps.logger.info(
      { crawlRunId: result.crawlRunId, ...summary, at: nowTimestamp(this.deps.clock) },
      'ingested collection output',
    );
    return summary;
  }

  private async resolveDocument(
    harvested: HarvestedRecord,
    crawlRunId: Uuid,
    context: IngestContext,
    cache: Map<string, Uuid>,
  ): Promise<Uuid> {
    const cached = cache.get(harvested.sourceUrl);
    if (cached !== undefined) return cached;

    const sourceDocumentId = await this.deps.ingestion.upsertSourceDocument({
      url: harvested.sourceUrl,
      urlCanonical: harvested.sourceUrl,
      urlHash: urlHash(harvested.sourceUrl),
      domain: domainOf(harvested.sourceUrl) ?? 'unknown',
      sourceTypeCode: context.sourceTypeCode,
      httpStatus: 200,
      contentHash: harvested.sourceContentHash,
      contentType: 'text/html',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: null,
      crawlRunId,
      retrievedAt: harvested.fetchedAt,
    });
    cache.set(harvested.sourceUrl, sourceDocumentId);
    return sourceDocumentId;
  }

  private async ingestOne(
    harvested: HarvestedRecord,
    sourceDocumentId: Uuid,
    crawlRunId: Uuid,
    context: IngestContext,
    summary: IngestSummary,
  ): Promise<boolean> {
    const record = harvested.record;

    // The public professional data boundary runs before anything is stored.
    const boundary = applyDataBoundary({
      full_name_published: record.fullNamePublished,
      title_published: record.titlePublished,
      department_published: record.departmentPublished,
      organization_published: record.organizationPublished,
      phone_published: record.phonePublished,
    });
    summary.boundaryDrops += boundary.findings.length;
    for (const finding of boundary.findings) {
      this.deps.logger.warn(
        { field: finding.field, kind: finding.kind, sourceUrl: harvested.sourceUrl },
        'value dropped at the public professional data boundary',
      );
    }
    if (boundary.allowed['full_name_published'] === undefined) return false;

    const parsed = parsePersonName(record.fullNamePublished);
    const title = normalizeTitle(record.titlePublished, context.titleRules);
    // An organization label must never vouch for a role inbox as personal.
    const nameForClassification = isOrganizationLabel(
      record.fullNamePublished,
      context.vocabulary.organizationLabelWords,
    )
      ? null
      : parsed;

    const emails: IngestEmailInput[] = [];
    for (const email of record.emails) {
      const [localPart, domain] = email.address.split('@');
      if (domain !== undefined && isPersonalEmailDomain(domain)) {
        summary.personalEmailsDropped += 1;
        continue;
      }

      const classification = classifyEmail({
        address: email.address,
        obfuscation: email.obfuscation,
        origin: 'observed',
        personName: nameForClassification,
        sharedInbox: {
          localParts: context.vocabulary.sharedInboxLocalParts,
          prefixes: context.vocabulary.sharedInboxPrefixes,
        },
      });
      if (!OBSERVED.includes(classification.classification)) continue;

      emails.push({
        address: email.address,
        addressNormalized: email.address.toLowerCase(),
        domain: domain ?? '',
        localPart: localPart ?? '',
        classification: classification.classification as IngestEmailInput['classification'],
        obfuscation: email.obfuscation,
        sourceValue: email.raw,
      });

      if (classification.classification === 'published') summary.publishedEmails += 1;
      else if (classification.classification === 'decoded_published') summary.decodedEmails += 1;
      else if (classification.classification === 'general_inbox') summary.generalInboxes += 1;
      else summary.invalidEmails += 1;
    }

    const contactPoints: IngestContactPointInput[] = [];
    const phone = record.phonePublished === null ? null : normalizePhone(record.phonePublished);
    if (phone !== null) {
      contactPoints.push({
        contactPointTypeCode: 'work_phone',
        value: phone,
        valueNormalized: phone.replace(/\D/g, ''),
        sourceValue: record.phonePublished,
      });
      summary.contactPoints += 1;
    }

    // A published department becomes a unit when the source named one.
    let organizationalUnitId: Uuid | null = null;
    if (record.departmentPublished !== null) {
      const unitName = normalizeUnitName(record.departmentPublished);
      organizationalUnitId = await this.deps.organizations.upsertUnit({
        organizationId: context.organizationId,
        name: unitName,
        nameNormalized: unitName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        nameSourceValue: record.departmentPublished,
        sourceDocumentId,
        crawlRunId,
        extractionMethod: record.extractionMethod,
        confidence: record.confidence,
        observedAt: harvested.fetchedAt,
      });
    }

    const result = await this.deps.ingestion.ingestPerson({
      recordKey: record.recordKey,
      organizationId: context.organizationId,
      organizationalUnitId,
      dutyLocationId: null,
      fullNamePublished: record.fullNamePublished,
      nameParts: parsed,
      identityKey: personIdentityKey({ organizationId: context.organizationId, parsed }),
      titlePublished: record.titlePublished,
      titleNormalized: title.titleNormalized.length > 0 ? title.titleNormalized : null,
      roleCategoryCode: title.roleCategoryCode,
      jobFamilyCode: title.jobFamilyCode,
      seniorityCode: title.seniorityCode,
      specialty: title.specialty,
      normalizationMethod: title.method,
      normalizationRuleSource: title.ruleSource,
      taxonomyVersion: title.taxonomyVersion,
      normalizationConfidence: title.confidence,
      departmentPublished: record.departmentPublished,
      emails,
      contactPoints,
      sourceDocumentId,
      crawlRunId,
      extractionMethod: record.extractionMethod,
      confidence: record.confidence,
      observedAt: harvested.fetchedAt,
    });

    await this.recordObservations(
      harvested,
      sourceDocumentId,
      crawlRunId,
      result.personId,
      context,
      summary,
    );
    return result.personCreated;
  }

  /**
   * One row per published field, tagged with what it proves.
   *
   * Employment evidence and contact evidence are recorded separately, so a
   * contact detail can be revised without disturbing the proof that the person
   * holds the role.
   */
  private async recordObservations(
    harvested: HarvestedRecord,
    sourceDocumentId: Uuid,
    crawlRunId: Uuid,
    personId: Uuid,
    context: IngestContext,
    summary: IngestSummary,
  ): Promise<void> {
    const record = harvested.record;
    const fields: readonly [string, string, string | null, string | null][] = [
      [
        'employment',
        'full_name_published',
        record.fullNamePublished,
        parsePersonName(record.fullNamePublished).displayName,
      ],
      [
        'employment',
        'title_published',
        record.titlePublished,
        normalizeTitle(record.titlePublished, context.titleRules).titleNormalized || null,
      ],
      [
        'employment',
        'department_published',
        record.departmentPublished,
        record.departmentPublished === null ? null : normalizeUnitName(record.departmentPublished),
      ],
      [
        'organization',
        'organization_published',
        record.organizationPublished,
        record.organizationPublished,
      ],
      [
        'contact',
        'phone_published',
        record.phonePublished,
        record.phonePublished === null ? null : normalizePhone(record.phonePublished),
      ],
      ...record.emails.map(
        (email) =>
          ['contact', `email_published:${email.address}`, email.raw, email.address] as [
            string,
            string,
            string | null,
            string | null,
          ],
      ),
    ];

    for (const [evidenceClass, field, valueRaw, valueNormalized] of fields) {
      if (valueRaw === null) continue;
      await this.deps.ingestion.recordObservation({
        sourceDocumentId,
        crawlRunId,
        evidenceClass,
        entityType: 'person',
        entityId: personId,
        recordKey: record.recordKey,
        field,
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
