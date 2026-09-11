import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import {
  applyDataBoundary,
  classifyEmail,
  collapseWhitespace,
  isOrganizationLabel,
  isPersonalEmailDomain,
  normalizeOrganizationName,
  parsePersonName,
} from '@public-workforce/core';
import { educationSectorPack } from '@public-workforce/sector-education';

export const LEGACY_CONTACT_MANIFEST_VERSION = 1;

export interface LegacyContactManifestFile {
  path: string;
  sha256: string;
  /** Durable location of the accepted export itself, not a claim that raw pages were archived. */
  archiveStorageKey?: string;
  /** Immutable public archive location, such as a GitHub git-blob API URL. */
  archiveUrl?: string;
}

export interface LegacyContactManifest {
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  contentCutoffAt: string;
  jurisdiction: 'texas-education';
  workbookSha256: string;
  approvedDomainAllowlistPath: string;
  approvedDomainAllowlistSha256: string;
  files: LegacyContactManifestFile[];
}

export interface LegacyContactRow {
  state?: unknown;
  state_published?: unknown;
  district?: unknown;
  school?: unknown;
  full_name?: unknown;
  title?: unknown;
  department?: unknown;
  email?: unknown;
  email_source?: unknown;
  directory_url?: unknown;
  data_source_url?: unknown;
  collected_at_utc?: unknown;
  canonical_source_row?: unknown;
  canonical_campus_key?: unknown;
  qa_identity_method?: unknown;
  source_dataset?: unknown;
  organization_website_published?: unknown;
  location_published?: unknown;
  city_published?: unknown;
  county_published?: unknown;
  grade_range_published?: unknown;
  [field: string]: unknown;
}

export interface TexasEducationOrganizationCandidate {
  organizationId: string;
  schoolName: string;
  districtName: string;
}

export interface PreparedLegacyContact {
  organizationId: string;
  districtPublished: string;
  schoolPublished: string;
  fullNamePublished: string;
  titlePublished: string | null;
  departmentPublished: string | null;
  emailPublished: string;
  emailClassification: 'published' | 'decoded_published';
  emailObfuscation: 'none' | 'cloudflare_cfemail';
  sourcePageUrl: string;
  observedAt: string;
  recordKey: string;
  artifactFields: Record<string, string>;
}

export type LegacyContactDisposition =
  { status: 'accepted'; record: PreparedLegacyContact } | { status: 'quarantined'; reason: string };

/** Streams plain NDJSON and gzip-compressed NDJSON without loading the bundle. */
export async function* streamLegacyContactLines(
  path: string,
): AsyncGenerator<{ lineNumber: number; line: string }> {
  const file = createReadStream(path);
  const input = createInterface({
    input: path.endsWith('.gz') ? file.pipe(createGunzip()) : file,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of input) {
    lineNumber += 1;
    yield { lineNumber, line };
  }
}

export function legacyArtifactContentType(path: string): string {
  return path.endsWith('.gz') ? 'application/gzip' : 'application/x-ndjson';
}

const INFERENCE_MARKERS = /\b(infer(?:red|ence)?|predict(?:ed|ion)?|generated|guessed|pattern)\b/i;
const PUBLISHED_EVIDENCE =
  /^(?:published|rendered|decoded|publicly displayed|public campus directory entry)\b/i;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Texas publishers abbreviate the same official names in repeatable ways.
 * This is an exact canonical key, not fuzzy matching: every replacement is a
 * declared Texas education abbreviation and both the input and spine rows pass
 * through the same function.
 */
export function texasEducationNameKey(value: string, kind: 'district' | 'school'): string {
  let expanded = collapseWhitespace(value)
    .replace(/\bCisd\b/gi, 'Consolidated Independent School District')
    .replace(/\bIsd\b/gi, 'Independent School District');
  if (kind === 'school') {
    expanded = expanded
      .replace(/\bEl\b/gi, 'Elementary School')
      .replace(/\bElem\b/gi, 'Elementary School')
      .replace(/\bElementary\b(?!\s+School)/gi, 'Elementary School')
      .replace(/\bH\s*S\b/gi, 'High School')
      .replace(/\bHigh\b(?!\s+School)/gi, 'High School')
      .replace(/\bJ\s*H\b/gi, 'Junior High School')
      .replace(/\bMiddle\b(?!\s+School)/gi, 'Middle School')
      .replace(/\bInt\b/gi, 'Intermediate School')
      .replace(/\bIntermediate\b(?!\s+School)/gi, 'Intermediate School');
  }
  return normalizeOrganizationName(expanded);
}

export class TexasEducationOrganizationIndex {
  private readonly candidates = new Map<string, TexasEducationOrganizationCandidate[]>();

  constructor(organizations: readonly TexasEducationOrganizationCandidate[]) {
    for (const organization of organizations) {
      const key = this.key(organization.districtName, organization.schoolName);
      const existing = this.candidates.get(key) ?? [];
      existing.push(organization);
      this.candidates.set(key, existing);
    }
  }

  exactMatch(district: string, school: string): TexasEducationOrganizationCandidate[] {
    return this.candidates.get(this.key(district, school)) ?? [];
  }

  private key(district: string, school: string): string {
    return `${texasEducationNameKey(district, 'district')}\u0000${texasEducationNameKey(school, 'school')}`;
  }
}

export function validateLegacyContactManifest(value: unknown): LegacyContactManifest {
  if (value === null || typeof value !== 'object') throw new Error('manifest must be an object');
  const manifest = value as Partial<LegacyContactManifest>;
  if (manifest.schemaVersion !== LEGACY_CONTACT_MANIFEST_VERSION)
    throw new Error(`manifest schemaVersion must be ${LEGACY_CONTACT_MANIFEST_VERSION}`);
  if (manifest.jurisdiction !== 'texas-education')
    throw new Error('manifest jurisdiction must be texas-education');
  if (
    typeof manifest.artifactId !== 'string' ||
    !/^[a-zA-Z0-9._-]{3,120}$/.test(manifest.artifactId)
  )
    throw new Error('manifest artifactId is invalid');
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)))
    throw new Error('manifest createdAt must be an ISO timestamp');
  if (
    typeof manifest.contentCutoffAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.contentCutoffAt))
  )
    throw new Error('manifest contentCutoffAt must be an ISO timestamp');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error('manifest must name at least one file');
  for (const [field, value] of [
    ['workbookSha256', manifest.workbookSha256],
    ['approvedDomainAllowlistSha256', manifest.approvedDomainAllowlistSha256],
  ] as const) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
      throw new Error(`manifest ${field} is invalid`);
  }
  if (
    typeof manifest.approvedDomainAllowlistPath !== 'string' ||
    manifest.approvedDomainAllowlistPath.trim().length === 0
  )
    throw new Error('manifest approvedDomainAllowlistPath is required');
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.trim().length === 0)
      throw new Error('manifest file path is required');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256))
      throw new Error(`manifest file has invalid sha256: ${String(file.path)}`);
    if (file.archiveStorageKey !== undefined && file.archiveStorageKey.trim().length === 0)
      throw new Error(`manifest file has empty archiveStorageKey: ${file.path}`);
    if (file.archiveUrl !== undefined && !isImmutableArchiveUrl(file.archiveUrl))
      throw new Error(
        `manifest file archiveUrl is not an immutable GitHub git-blob URL: ${file.path}`,
      );
  }
  return manifest as LegacyContactManifest;
}

function isImmutableArchiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.github.com' &&
      /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/[a-f0-9]{40,64}$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function prepareLegacyContact(
  row: LegacyContactRow,
  index: TexasEducationOrganizationIndex,
  artifactId: string,
  line: number,
  approvedDomains?: ReadonlySet<string>,
): LegacyContactDisposition {
  const state = text(row.state_published ?? row.state);
  const district = text(row.district);
  const school = text(row.school);
  const fullName = text(row.full_name);
  const title = nullableText(row.title);
  const department = nullableText(row.department);
  const email = text(row.email).toLowerCase();
  const emailSource = text(row.email_source);
  const sourcePageUrl = text(row.directory_url) || text(row.data_source_url);

  if (state.length > 0 && !/^texas$|^tx$/i.test(state)) return quarantine('row is outside Texas');
  if (district.length === 0 || school.length === 0)
    return quarantine('district and school are required for exact organization mapping');
  if (fullName.length === 0) return quarantine('published full name is required');
  if (/\b(school|campus|district)\b.*\b(office|staff|directory|team)\b/i.test(fullName))
    return quarantine('name is an organization label, not a person');
  if (isOrganizationLabel(fullName, educationSectorPack.vocabulary?.organizationLabelWords ?? []))
    return quarantine('name is an organization label, not a person');
  if (fullName.split(/\s+/).filter((part) => /[a-z]/i.test(part)).length < 2)
    return quarantine('name is not safely person-shaped');
  if (!EMAIL_PATTERN.test(email)) return quarantine('email is invalid');
  const domain = email.split('@')[1];
  if (domain === undefined || isPersonalEmailDomain(domain))
    return quarantine('email is personal rather than a public work address');
  if (INFERENCE_MARKERS.test(emailSource))
    return quarantine('email provenance says the address was inferred or generated');
  if (!PUBLISHED_EVIDENCE.test(emailSource))
    return quarantine('email provenance lacks positive published or decoded evidence');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourcePageUrl);
  } catch {
    return quarantine('a human-viewable source page URL is required');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol))
    return quarantine('source page URL must use http or https');
  if (
    parsedUrl.hostname.toLowerCase() === 'api' ||
    /^api\.|\.api\./i.test(parsedUrl.hostname) ||
    /\/api(?:\/|\?|\.)|\/graphql|\/ajax\/|\/endpoint\//i.test(parsedUrl.toString()) ||
    /\.(?:json|xml)$/i.test(parsedUrl.pathname)
  )
    return quarantine('source page URL is an API or data endpoint, not a human-viewable page');
  if (approvedDomains !== undefined && !isApprovedHost(parsedUrl.hostname, approvedDomains))
    return quarantine('source page domain is outside the workbook-approved allowlist');

  const boundary = applyDataBoundary({
    full_name_published: fullName,
    title_published: title,
    department_published: department,
  });
  if (boundary.findings.length > 0 || boundary.allowed['full_name_published'] === undefined)
    return quarantine('row failed the public professional data boundary');

  const matches = index.exactMatch(district, school);
  if (matches.length === 0) return quarantine('no exact Texas district and school match');
  if (matches.length > 1) return quarantine('Texas district and school match is ambiguous');

  const emailObfuscation = /cloudflare|cfemail/i.test(emailSource) ? 'cloudflare_cfemail' : 'none';
  const emailClassification = classifyEmail({
    address: email,
    obfuscation: emailObfuscation,
    origin: 'observed',
    personName: parsePersonName(fullName),
    sharedInbox: {
      localParts: educationSectorPack.vocabulary?.sharedInboxLocalParts ?? [],
      prefixes: educationSectorPack.vocabulary?.sharedInboxPrefixes ?? [],
    },
  });
  if (emailClassification.classification === 'invalid') return quarantine('email is invalid');
  if (emailClassification.classification === 'general_inbox')
    return quarantine('email is a general inbox, not a named staff address');

  const observed = text(row.collected_at_utc);
  const observedAt = Number.isFinite(Date.parse(observed)) ? new Date(observed).toISOString() : '';
  if (observedAt.length === 0) return quarantine('collected_at_utc is missing or invalid');

  const canonical = [artifactId, line, district, school, fullName, email].join('\u0000');
  const artifactFields = safeArtifactFields(row);
  return {
    status: 'accepted',
    record: {
      organizationId: matches[0]!.organizationId,
      districtPublished: district,
      schoolPublished: school,
      fullNamePublished: boundary.allowed['full_name_published'],
      titlePublished: boundary.allowed['title_published'] ?? null,
      departmentPublished: boundary.allowed['department_published'] ?? null,
      emailPublished: email,
      emailClassification:
        emailClassification.classification === 'decoded_published'
          ? 'decoded_published'
          : 'published',
      emailObfuscation,
      sourcePageUrl: parsedUrl.toString(),
      observedAt,
      recordKey: `legacy:${createHash('sha256').update(canonical).digest('hex')}`,
      artifactFields,
    },
  };
}

function isApprovedHost(hostname: string, approvedDomains: ReadonlySet<string>): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  for (const domain of approvedDomains) {
    const allowed = domain
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function text(value: unknown): string {
  return typeof value === 'string' ? collapseWhitespace(value) : '';
}

function artifactText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
}

function safeArtifactFields(row: LegacyContactRow): Record<string, string> {
  const values: Record<string, string> = {};
  const add = (field: string, value: unknown, pattern: RegExp): void => {
    const normalized = artifactText(value);
    if (normalized.length > 0 && normalized.length <= 500 && pattern.test(normalized))
      values[field] = normalized;
  };
  const place = /^[\p{L}\p{M}0-9 .,'&()/-]+$/u;
  add('state_published', row.state_published ?? row.state, /^(?:Texas|TX)$/i);
  add('county_published', row.county_published ?? row.county, place);
  add('city_published', row.city_published ?? row.city, place);
  add('grade_range_published', row.grade_range_published ?? row.grade_range, /^[A-Z0-9 -]+$/i);
  const website = artifactText(row.organization_website_published ?? row.school_website);
  try {
    const parsed = new URL(website);
    if (['http:', 'https:'].includes(parsed.protocol))
      values['organization_website_published'] = parsed.toString();
  } catch {
    // An invalid optional artifact field is omitted rather than normalized into truth.
  }
  add('location_published', row.location_published ?? row.location, place);
  add('email_source_description', row.email_source, /^[\p{L}\p{M}0-9 .,'&()/_-]+$/u);
  const sourceDataset = artifactText(row.source_dataset);
  if (/^(?:batch1|batch2)$/.test(sourceDataset)) {
    values['source_dataset'] = sourceDataset;
    values['source_file'] = sourceDataset;
  }
  const canonicalSourceRow = artifactText(row.canonical_source_row);
  if (/^\d+$/.test(canonicalSourceRow)) {
    values['canonical_source_row'] = canonicalSourceRow;
    values['source_line'] = canonicalSourceRow;
  }
  add('canonical_campus_key', row.canonical_campus_key, /^[\p{L}\p{M}0-9 .,'&()/:_|-]+$/u);
  add('qa_identity_method', row.qa_identity_method, /^[a-z0-9_]+$/);
  return values;
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText.length === 0 ? null : valueText;
}

function quarantine(reason: string): LegacyContactDisposition {
  return { status: 'quarantined', reason };
}
