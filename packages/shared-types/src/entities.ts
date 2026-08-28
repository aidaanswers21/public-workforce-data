import type {
  EmailCandidateState,
  EmailClassification,
  EmailValidationStatus,
  ExtractionMethod,
  ObfuscationKind,
  OrgScope,
  RecordStatus,
  RoleCategory,
  SeniorityLevel,
  SourceType,
  SuppressionScope,
  SuppressionSource,
  ComplaintChannel,
  ExportStatus,
} from './enums.js';

export type Uuid = string;
/** RFC3339 / ISO-8601 UTC timestamp. */
export type Timestamp = string;

/**
 * Provenance carried by every material value.
 *
 * `sourcePageId` is the page the value was read from. Inferred values instead
 * carry `inferenceEvidenceId`. One of the two is always present, which is what
 * makes "every material value is traceable" enforceable rather than aspirational.
 */
export interface Provenance {
  sourcePageId: Uuid | null;
  inferenceEvidenceId: Uuid | null;
  crawlRunId: Uuid | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
}

export interface StateRecord {
  id: Uuid;
  code: string;
  name: string;
  fipsCode: string | null;
  configKey: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CountyRecord {
  id: Uuid;
  stateId: Uuid;
  name: string;
  nameNormalized: string;
  fipsCode: string | null;
  sourceValue: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Officially issued identifiers, kept separate from our surrogate keys. */
export interface ExternalIdentifiers {
  ncesId: string | null;
  stateAgencyId: string | null;
  federalEin: string | null;
}

export interface DistrictRecord {
  id: Uuid;
  stateId: Uuid;
  countyId: Uuid | null;
  name: string;
  nameNormalized: string;
  nameSourceValue: string | null;
  identifiers: ExternalIdentifiers;
  websiteUrl: string | null;
  primaryDomain: string | null;
  emailDomains: string[];
  status: RecordStatus;
  provenance: Provenance;
}

export interface SchoolRecord {
  id: Uuid;
  districtId: Uuid;
  stateId: Uuid;
  countyId: Uuid | null;
  name: string;
  nameNormalized: string;
  nameSourceValue: string | null;
  identifiers: ExternalIdentifiers;
  schoolLevel: string | null;
  lowGrade: string | null;
  highGrade: string | null;
  websiteUrl: string | null;
  primaryDomain: string | null;
  status: RecordStatus;
  provenance: Provenance;
}

export interface DepartmentRecord {
  id: Uuid;
  scope: OrgScope;
  scopeId: Uuid;
  name: string;
  nameNormalized: string;
  nameSourceValue: string | null;
  provenance: Provenance;
}

/** Parsed name parts. Every field is nullable: sources publish what they publish. */
export interface NameParts {
  prefix: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
}

export interface PersonRecord {
  id: Uuid;
  stateId: Uuid;
  fullNamePublished: string;
  nameParts: NameParts;
  /** Stable within a state + org scope. Used for cross-run identity resolution. */
  identityKey: string;
  status: RecordStatus;
  provenance: Provenance;
}

export interface EmploymentAssignmentRecord {
  id: Uuid;
  personId: Uuid;
  districtId: Uuid | null;
  schoolId: Uuid | null;
  departmentId: Uuid | null;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategory: RoleCategory;
  seniority: SeniorityLevel;
  isPrimary: boolean;
  status: RecordStatus;
  provenance: Provenance;
}

export interface EmailAddressRecord {
  id: Uuid;
  personId: Uuid | null;
  employmentAssignmentId: Uuid | null;
  districtId: Uuid | null;
  schoolId: Uuid | null;
  address: string;
  addressNormalized: string;
  domain: string;
  localPart: string;
  classification: EmailClassification;
  obfuscation: ObfuscationKind;
  /** Raw text as displayed on the page, before decoding or normalization. */
  sourceValue: string | null;
  validationStatus: EmailValidationStatus;
  latestValidationResultId: Uuid | null;
  status: RecordStatus;
  provenance: Provenance;
}

export interface EmailPatternEvidence {
  /** Pattern token expression, e.g. `{first}.{last}`. */
  pattern: string;
  /** Published addresses on the same domain that match the pattern. */
  supportingExamples: string[];
  supportCount: number;
  /** Published addresses on the domain that contradict the pattern. */
  conflictCount: number;
  /** supportCount / (supportCount + conflictCount). */
  consistency: number;
}

export interface EmailCandidateRecord {
  id: Uuid;
  personId: Uuid;
  employmentAssignmentId: Uuid | null;
  domain: string;
  address: string;
  pattern: string;
  evidence: EmailPatternEvidence;
  /** Confidence in the *inference*. Never a substitute for validation. */
  confidence: number;
  state: EmailCandidateState;
  validationStatus: EmailValidationStatus;
  latestValidationResultId: Uuid | null;
  /**
   * Set only when a provider actually returned "valid".
   *
   * Promotion never moves the address into `email_addresses`: that table holds
   * only what a source displayed, so a validated guess stays a guess in the
   * record even once we believe it is deliverable.
   */
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

export interface SourcePageRecord {
  id: Uuid;
  url: string;
  urlCanonical: string;
  urlHash: string;
  domain: string;
  sourceType: SourceType;
  httpStatus: number | null;
  contentHash: string | null;
  contentType: string | null;
  /** Object-storage key for the archived raw response. */
  storageKey: string | null;
  robotsAllowed: boolean | null;
  robotsPolicyNote: string | null;
  crawlRunId: Uuid | null;
  fetchedAt: Timestamp;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
}

/**
 * One observed field value on one page. This is the append-only evidence table
 * behind every normalized record.
 */
export interface SourceObservationRecord {
  id: Uuid;
  sourcePageId: Uuid;
  crawlRunId: Uuid | null;
  entityType: string;
  entityId: Uuid | null;
  /** Deterministic per-source record key, stable across recrawls. */
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

export interface SuppressionEntryRecord {
  id: Uuid;
  scope: SuppressionScope;
  /** Normalized match value: email address, domain, or entity id as text. */
  value: string;
  personId: Uuid | null;
  schoolId: Uuid | null;
  districtId: Uuid | null;
  stateId: Uuid | null;
  reason: string;
  source: SuppressionSource;
  effectiveAt: Timestamp;
  expiresAt: Timestamp | null;
  /** Set instead of deleting. Suppression rows are never updated in place. */
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
  filters: Record<string, unknown>;
  status: ExportStatus;
  rowCount: number;
  suppressedCount: number;
  filePath: string | null;
  checksum: string | null;
  /** Timestamp of the suppression re-check performed immediately before writing. */
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
  /** Hash chain over (prevHash, occurredAt, actor, action, entityType, entityId, payload). */
  prevHash: string | null;
  hash: string;
}
