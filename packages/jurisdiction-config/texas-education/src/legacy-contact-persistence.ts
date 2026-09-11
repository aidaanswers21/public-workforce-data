import { createHash } from 'node:crypto';
import {
  hashObject,
  normalizeTitle,
  parsePersonName,
  personIdentityKey,
  urlHash,
} from '@public-workforce/core';
import {
  IngestionRepository,
  type SqlClient,
  type SourceDocumentVersionRef,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { SENIORITY_MODIFIERS, Taxonomy } from '@public-workforce/taxonomy';
import {
  legacyArtifactContentType,
  type LegacyContactManifestFile,
  type PreparedLegacyContact,
} from './legacy-contact-import.js';

const TAXONOMY = new Taxonomy([educationSectorPack]);
const SCOPED = TAXONOMY.forScope({
  sectorCode: 'education',
  governmentLevelCode: 'special_district',
});
const JOB_FAMILY_BY_ROLE = new Map(
  TAXONOMY.roleCategories.map((role) => [role.code, role.jobFamilyCode]),
);
const TITLE_RULES = {
  rules: SCOPED.titleRules,
  abbreviations: SCOPED.titleAbbreviations,
  seniorityModifiers: SENIORITY_MODIFIERS,
  specialtyPatterns: SCOPED.specialtyPatterns,
  fallbackRoleCategoryCode: 'other',
  unknownRoleCategoryCode: 'unknown',
  jobFamilyForRole: (code: string) => JOB_FAMILY_BY_ROLE.get(code) ?? 'unknown',
  version: hashObject({
    pack: educationSectorPack.key,
    rules: SCOPED.titleRules.map((rule) => rule.test.source),
  }).slice(0, 16),
};

export async function recordLegacyArtifact(
  client: SqlClient,
  file: LegacyContactManifestFile,
  artifactId: string,
  contentHash: string,
  artifactCreatedAt: string,
): Promise<SourceDocumentVersionRef> {
  const logicalUrl = `urn:public-workforce:file-import:${artifactId}:${createHash('sha256').update(file.path).digest('hex').slice(0, 16)}`;
  const artifactUrl = file.archiveUrl ?? logicalUrl;
  return new IngestionRepository(client).recordSourceDocument({
    url: artifactUrl,
    urlCanonical: artifactUrl,
    urlHash: urlHash(artifactUrl),
    domain: file.archiveUrl === undefined ? 'local.file-import' : 'api.github.com',
    sourceTypeCode: 'other',
    httpStatus: null,
    contentHash,
    contentType: legacyArtifactContentType(file.path),
    storageKey: file.archiveStorageKey ?? null,
    robotsAllowed: null,
    robotsPolicyNote:
      'Operator-supplied accepted-contact export; not a stored copy of the linked web page.',
    sourcePolicyId: null,
    crawlRunId: null,
    retrievedAt: new Date(artifactCreatedAt).toISOString(),
  });
}

export async function importPreparedLegacyContact(
  client: SqlClient,
  record: PreparedLegacyContact,
  artifactSource: SourceDocumentVersionRef,
  artifact: { artifactId: string; archiveReference: string; sha256: string },
): Promise<void> {
  const ingestion = new IngestionRepository(client);
  const parsed = parsePersonName(record.fullNamePublished);
  const title = normalizeTitle(record.titlePublished, TITLE_RULES);
  const [localPart, domain] = record.emailPublished.split('@') as [string, string];
  const result = await ingestion.ingestPerson({
    recordKey: record.recordKey,
    organizationId: record.organizationId,
    organizationalUnitId: null,
    dutyLocationId: null,
    fullNamePublished: record.fullNamePublished,
    nameParts: parsed,
    identityKey: personIdentityKey({ organizationId: record.organizationId, parsed }),
    titlePublished: record.titlePublished,
    titleNormalized: title.titleNormalized || null,
    roleCategoryCode: title.roleCategoryCode,
    jobFamilyCode: title.jobFamilyCode,
    seniorityCode: title.seniorityCode,
    specialty: title.specialty,
    normalizationMethod: title.method,
    normalizationRuleSource: title.ruleSource,
    taxonomyVersion: title.taxonomyVersion,
    normalizationConfidence: title.confidence,
    departmentPublished: record.departmentPublished,
    emails: [
      {
        address: record.emailPublished,
        addressNormalized: record.emailPublished,
        domain,
        localPart,
        classification: record.emailClassification,
        obfuscation: record.emailObfuscation,
        sourceValue: record.emailPublished,
      },
    ],
    sourceDocumentId: artifactSource.documentId,
    crawlRunId: null,
    extractionMethod: 'file_import',
    confidence: 0.8,
    observedAt: record.observedAt,
  });
  const observations: [string, string, string | null, string | null][] = [
    ['employment', 'full_name_published', record.fullNamePublished, parsed.displayName],
    ['employment', 'title_published', record.titlePublished, title.titleNormalized || null],
    ['employment', 'department_published', record.departmentPublished, record.departmentPublished],
    ['organization', 'district_published', record.districtPublished, record.districtPublished],
    ['organization', 'school_published', record.schoolPublished, record.schoolPublished],
    [
      'contact',
      `email_published:${record.emailPublished}`,
      record.emailPublished,
      record.emailPublished,
    ],
    ['contact', 'source_page_url', record.sourcePageUrl, record.sourcePageUrl],
  ];
  for (const [evidenceClass, field, raw, normalized] of observations) {
    if (raw === null) continue;
    await ingestion.recordObservation({
      sourceDocumentVersionId: artifactSource.versionId,
      crawlRunId: null,
      evidenceClass,
      entityType: 'person',
      entityId: result.personId,
      recordKey: record.recordKey,
      field,
      valueRaw: raw,
      valueNormalized: normalized,
      extractionMethod: 'file_import',
      confidence: 0.8,
      selector: null,
      observedAt: record.observedAt,
    });
  }
  const artifactObservations: [string, string][] = [
    ['legacy_artifact_id', artifact.artifactId],
    ['legacy_artifact_archive_reference', artifact.archiveReference],
    ['legacy_artifact_sha256', artifact.sha256],
    ...Object.entries(record.artifactFields),
  ];
  for (const [field, value] of artifactObservations) {
    await ingestion.recordObservation({
      sourceDocumentVersionId: artifactSource.versionId,
      crawlRunId: null,
      evidenceClass: 'contact',
      entityType: 'person',
      entityId: result.personId,
      recordKey: record.recordKey,
      field,
      valueRaw: value,
      valueNormalized: value,
      extractionMethod: 'file_import',
      confidence: 1,
      selector: null,
      observedAt: record.observedAt,
    });
  }
}

export async function seedLegacyRevalidationTarget(
  client: SqlClient,
  record: PreparedLegacyContact,
  sourceDocumentId: string,
): Promise<void> {
  await client.query(
    `with target as (
       insert into crawl_targets (
         organization_id, jurisdiction_id, url, url_hash, target_type,
         source_type_code, status, priority
       ) select $1, organization.jurisdiction_id, $2, $3,
                'organization_directory', 'html_directory', 'pending', 75
         from organizations organization where organization.id = $1
       on conflict (url_hash) do update set updated_at = crawl_targets.updated_at
       returning id
     )
     insert into crawl_target_organizations (
       crawl_target_id, organization_id, source_document_id
     ) select target.id, $1, $4 from target
     on conflict do nothing`,
    [record.organizationId, record.sourcePageUrl, urlHash(record.sourcePageUrl), sourceDocumentId],
  );
}
