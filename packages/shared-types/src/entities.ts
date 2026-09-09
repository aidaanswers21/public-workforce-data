import type {
  AssignmentStatus,
  CollectionStatus,
  ComplaintChannel,
  EmailCandidateState,
  EmailClassification,
  EmailValidationStatus,
  ExportStatus,
  ExtractionMethod,
  NormalizationMethod,
  ObfuscationKind,
  PolicyStance,
  RecordStatus,
  SuppressionScope,
  SuppressionSource,
} from './enums.js';

export type Uuid = string;
/** RFC3339 / ISO-8601 UTC timestamp. */
export type Timestamp = string;
/** Calendar date, YYYY-MM-DD. Used where a source publishes a date without a time. */
export type DateOnly = string;

/**
 * Provenance carried by every material value.
 *
 * One of `sourceDocumentId` or `inferenceEvidenceId` is always present, which is
 * what makes "every material value is traceable" a database constraint rather
 * than an aspiration.
 */
export interface Provenance {
  sourceDocumentId: Uuid | null;
  inferenceEvidenceId: Uuid | null;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
}

/* -------------------------------------------------------------------------- */
/* Geography and jurisdiction                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A place.
 *
 * Deliberately independent of both jurisdiction and employer hierarchy. A
 * federal office sits in a county without the county having any authority over
 * it, and a school sits in a municipality while belonging to a district.
 */
export interface GeographicAreaRecord {
  id: Uuid;
  /** Reference code from the taxonomy, e.g. `state`, `county`, `zip_code`. */
  areaTypeCode: string;
  name: string;
  nameNormalized: string;
  /** Containing area, e.g. a county inside a state. Null for a country. */
  parentAreaId: Uuid | null;
  /** Two letter postal abbreviation, when the area is a state or territory. */
  stateCode: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The authority an organization operates under.
 *
 * A jurisdiction names a level of government and, where meaningful, the area it
 * covers. Federal jurisdictions have no state above them; this is the field
 * that stops the model demanding one.
 */
export interface JurisdictionRecord {
  id: Uuid;
  code: string;
  name: string;
  /** Reference code from the taxonomy, e.g. `federal`, `state`, `county`. */
  governmentLevelCode: string;
  /** The area the jurisdiction covers, when it has one. Null for nationwide bodies. */
  geographicAreaId: Uuid | null;
  /** A containing jurisdiction, where one genuinely exists. Often null. */
  parentJurisdictionId: Uuid | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/* -------------------------------------------------------------------------- */
/* Organizations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Any public body: a federal bureau, a state agency, a county department, a
 * municipality, a special district or a school.
 *
 * There is no parent column. Hierarchy is effective-dated and lives in
 * `organization_relationships`, because public-sector reporting lines change,
 * overlap and occasionally run in more than one direction at once.
 */
export interface OrganizationRecord {
  id: Uuid;
  /** Reference code from the taxonomy, e.g. `federal_bureau`, `school`. */
  organizationTypeCode: string;
  /** Independently recorded when supported by source evidence. */
  governmentLevelCode: string | null;
  sectorCode: string;
  jurisdictionId: Uuid | null;
  name: string;
  nameNormalized: string;
  nameSourceValue: string | null;
  legalName: string | null;
  /** Common short form or acronym, when published. */
  shortName: string | null;
  websiteUrl: string | null;
  primaryDomain: string | null;
  emailDomains: string[];
  status: RecordStatus;
  provenance: Provenance;
}

/** An effective-dated edge between two organizations. */
export interface OrganizationRelationshipRecord {
  id: Uuid;
  parentOrganizationId: Uuid;
  childOrganizationId: Uuid;
  /** Reference code from the taxonomy, e.g. `part_of`, `reports_to`, `succeeds`. */
  relationshipTypeCode: string;
  effectiveFrom: DateOnly;
  /** Null while the relationship is current. */
  effectiveTo: DateOnly | null;
  notes: string | null;
  provenance: Provenance;
}

/** A subdivision inside one organization: a division, bureau-level unit or team. */
export interface OrganizationalUnitRecord {
  id: Uuid;
  organizationId: Uuid;
  parentUnitId: Uuid | null;
  name: string;
  nameNormalized: string;
  nameSourceValue: string | null;
  provenance: Provenance;
}

/** A physical or mailing location an organization operates from. */
export interface OrganizationLocationRecord {
  id: Uuid;
  organizationId: Uuid;
  /** e.g. `headquarters`, `field_office`, `mailing`. Free text with common values. */
  locationType: string;
  name: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  countryCode: string;
  /** The area this location sits in, resolved where possible. */
  geographicAreaId: Uuid | null;
  isPrimary: boolean;
  effectiveFrom: DateOnly | null;
  effectiveTo: DateOnly | null;
  provenance: Provenance;
}

/**
 * An officially issued identifier for an organization, area or jurisdiction.
 *
 * Generic on purpose: an NCES district id, a Treasury agency code and a state's
 * own numbering all live on this table, so a new identifier system needs a
 * reference row rather than a column.
 */
export interface ExternalIdentifierRecord {
  id: Uuid;
  entityType: 'organization' | 'geographic_area' | 'jurisdiction' | 'person';
  entityId: Uuid;
  /** Reference code from the taxonomy, e.g. `nces_school_id`, `fips_county`. */
  identifierSystemCode: string;
  identifierValue: string;
  /** The state that issued it, for state-assigned systems. */
  issuingStateCode: string | null;
  isPrimary: boolean;
  provenance: Provenance;
}

/* -------------------------------------------------------------------------- */
/* People, employment and contact                                             */
/* -------------------------------------------------------------------------- */

export interface NameParts {
  prefix: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
}

/**
 * A person.
 *
 * Carries no title, no department and no employer. All three belong to an
 * assignment, because one person can hold several at once and has held others
 * before.
 */
export interface PersonRecord {
  id: Uuid;
  fullNamePublished: string;
  nameParts: NameParts;
  /** Stable within one organization. Used for cross-run identity resolution. */
  identityKey: string;
  status: RecordStatus;
  provenance: Provenance;
}

/** How a published title was interpreted, kept separate from the title itself. */
export interface TitleNormalization {
  /** Exactly as the source published it. Never overwritten. */
  titlePublished: string | null;
  titleNormalized: string | null;
  /** Reference codes from the taxonomy. */
  roleCategoryCode: string;
  jobFamilyCode: string;
  seniorityCode: string;
  /** Subject, grade band, beat or other specialty the title carried. */
  specialty: string | null;
  method: NormalizationMethod;
  /** Which rule pack produced the match, for audit. */
  ruleSource: string | null;
  /** Version of the taxonomy that produced it, so a re-run is comparable. */
  taxonomyVersion: string;
  confidence: number;
}

/**
 * One person holding one role at one organization, over a period.
 *
 * Multiple simultaneous assignments are ordinary in the public sector: a county
 * employee may also sit on a district board. Nothing here assumes one employer.
 */
export interface EmploymentAssignmentRecord {
  id: Uuid;
  personId: Uuid;
  organizationId: Uuid;
  organizationalUnitId: Uuid | null;
  /** Where this person actually works, which need not be the employer's seat. */
  dutyLocationId: Uuid | null;
  title: TitleNormalization;
  /** Department name exactly as published, when no unit could be resolved. */
  departmentPublished: string | null;
  isPrimary: boolean;
  assignmentStatus: AssignmentStatus;
  effectiveFrom: DateOnly | null;
  effectiveTo: DateOnly | null;
  provenance: Provenance;
}

/**
 * A professional contact point other than email.
 *
 * Email keeps its own tables because published and inferred addresses must stay
 * structurally apart; phones, extensions and office addresses have no inferred
 * equivalent and live here.
 */
export interface ContactPointRecord {
  id: Uuid;
  /** Exactly one of these is set. */
  personId: Uuid | null;
  employmentAssignmentId: Uuid | null;
  organizationId: Uuid | null;
  /** Reference code from the taxonomy, e.g. `work_phone`, `office_address`. */
  contactPointTypeCode: string;
  value: string;
  valueNormalized: string;
  /** Verbatim, before normalization. */
  sourceValue: string | null;
  isPrimary: boolean;
  status: RecordStatus;
  provenance: Provenance;
}

export interface EmailAddressRecord {
  id: Uuid;
  personId: Uuid | null;
  employmentAssignmentId: Uuid | null;
  organizationId: Uuid | null;
  address: string;
  addressNormalized: string;
  domain: string;
  localPart: string;
  classification: EmailClassification;
  obfuscation: ObfuscationKind;
  sourceValue: string | null;
  validationStatus: EmailValidationStatus;
  latestValidationResultId: Uuid | null;
  status: RecordStatus;
  provenance: Provenance;
}

export interface EmailPatternEvidence {
  pattern: string;
  supportingExamples: string[];
  supportCount: number;
  conflictCount: number;
  consistency: number;
}

export interface EmailCandidateRecord {
  id: Uuid;
  personId: Uuid;
  employmentAssignmentId: Uuid | null;
  organizationId: Uuid | null;
  domain: string;
  address: string;
  pattern: string;
  evidence: EmailPatternEvidence;
  /** Confidence in the inference. Never a deliverability claim. */
  confidence: number;
  state: EmailCandidateState;
  validationStatus: EmailValidationStatus;
  latestValidationResultId: Uuid | null;
  promotedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface EmailValidationResultRecord {
  id: Uuid;
  emailAddressId: Uuid | null;
  emailCandidateId: Uuid | null;
  provider: string;
  providerRequestId: string | null;
  status: EmailValidationStatus;
  subStatus: string | null;
  score: number | null;
  raw: Record<string, unknown>;
  validatedAt: Timestamp;
}

/* -------------------------------------------------------------------------- */
/* Sources and evidence                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One retrieved source artefact: a page, an API response, a dataset row set, a
 * spreadsheet or a PDF.
 */
export interface SourceDocumentRecord {
  id: Uuid;
  url: string;
  urlCanonical: string;
  urlHash: string;
  domain: string;
  /** Reference code from the taxonomy, e.g. `html_directory`, `open_data_portal`. */
  sourceTypeCode: string;
  httpStatus: number | null;
  contentHash: string | null;
  contentType: string | null;
  storageKey: string | null;
  robotsAllowed: boolean | null;
  robotsPolicyNote: string | null;
  /** The policy row that permitted this retrieval, when one applied. */
  sourcePolicyId: Uuid | null;
  crawlRunId: Uuid | null;
  retrievedAt: Timestamp;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
}

/**
 * One observed field value in one source document.
 *
 * `evidenceClass` separates what a source proves. A roster may establish
 * employment while a contact page supplies the address, and either can be
 * revised without disturbing the other.
 */
export interface SourceObservationRecord {
  id: Uuid;
  sourceDocumentId: Uuid;
  crawlRunId: Uuid | null;
  /** Reference code: `organization`, `employment`, `contact`, `location`, `policy`. */
  evidenceClass: string;
  entityType: string;
  entityId: Uuid | null;
  recordKey: string;
  field: string;
  valueRaw: string | null;
  valueNormalized: string | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  selector: string | null;
  observedAt: Timestamp;
}

export interface DirectoryPlatformRecord {
  id: Uuid;
  key: string;
  name: string;
  adapterKey: string;
  adapterVersion: string;
  detectionNotes: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A recorded decision about whether, and on what terms, a source may be used.
 *
 * The crawler refuses production collection from anything marked prohibited or
 * review_required until a person has recorded an approval on the row. A vendor
 * asserting that data is compliant does not change any of these fields.
 */
export interface SourcePolicyRecord {
  id: Uuid;
  domain: string | null;
  urlPattern: string | null;
  organizationId: Uuid | null;
  jurisdictionId: Uuid | null;
  sourceTypeCode: string | null;
  collectionStatus: CollectionStatus;
  commercialUseStatus: PolicyStance;
  solicitationStatus: PolicyStance;
  automatedAccessStatus: PolicyStance;
  policyUrl: string | null;
  /** Verbatim excerpt of the governing text, kept so a later change is visible. */
  policyTextSnapshot: string | null;
  policyTextHash: string | null;
  effectiveAt: Timestamp;
  lastReviewedAt: Timestamp | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  /** Set only by a person, and only after reading the policy. */
  productionApprovedBy: string | null;
  productionApprovedAt: Timestamp | null;
  productionApprovalNote: string | null;
  createdAt: Timestamp;
}

/* -------------------------------------------------------------------------- */
/* Compliance                                                                 */
/* -------------------------------------------------------------------------- */

export interface SuppressionEntryRecord {
  id: Uuid;
  scope: SuppressionScope;
  /** Normalized match value: an address, a domain, an entity id or a code. */
  value: string;
  personId: Uuid | null;
  organizationId: Uuid | null;
  jurisdictionId: Uuid | null;
  geographicAreaId: Uuid | null;
  sourceDocumentId: Uuid | null;
  /** Set for `government_level` scope. */
  governmentLevelCode: string | null;
  /** Set for `export_purpose` scope. */
  exportPurpose: string | null;
  reason: string;
  source: SuppressionSource;
  effectiveAt: Timestamp;
  expiresAt: Timestamp | null;
  revokedAt: Timestamp | null;
  revokedReason: string | null;
  createdBy: string;
  createdAt: Timestamp;
}

export interface ComplaintRecord {
  id: Uuid;
  receivedAt: Timestamp;
  channel: ComplaintChannel;
  contactType: string;
  contactValue: string;
  reason: string;
  notes: string | null;
  suppressionEntryId: Uuid | null;
  createdAt: Timestamp;
}

export interface ExportRecord {
  id: Uuid;
  name: string;
  requestedBy: string;
  /** Declared purpose, checked against `export_purpose` suppression entries. */
  purpose: string;
  filters: Record<string, unknown>;
  status: ExportStatus;
  rowCount: number;
  suppressedCount: number;
  filePath: string | null;
  checksum: string | null;
  suppressionCheckedAt: Timestamp | null;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
}

export interface AuditEventRecord {
  id: Uuid;
  occurredAt: Timestamp;
  actor: string;
  action: string;
  entityType: string;
  entityId: Uuid | null;
  payload: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}
