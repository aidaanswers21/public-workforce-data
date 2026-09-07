import { canonicalizeUrl, domainOf, normalizeOrganizationName } from '@public-workforce/core';

export interface SpineIdentifier {
  systemCode: string;
  value: string;
  issuingStateCode: string | null;
}

export interface SpineLocation {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  countyName: string | null;
  countyFips: string | null;
}

export interface SpineSourceRecord {
  schemaVersion: 1;
  sourceKey: string;
  sourceRecordKey: string;
  sourceEffectiveDate: string | null;
  name: string;
  nameNormalized: string;
  organizationTypeCode: string | null;
  governmentLevelCode: string | null;
  sectorCode: string | null;
  classificationReviewReason: string | null;
  identifiers: SpineIdentifier[];
  parentIdentifiers: SpineIdentifier[];
  location: SpineLocation;
  website: {
    publishedValue: string;
    canonicalUrl: string;
    primaryDomain: string;
  } | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface WebsiteResolutionQueueRecord {
  sourceKey: string;
  sourceRecordKey: string;
  name: string;
  identifiers: SpineIdentifier[];
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  nextStages: readonly [
    'exact_identifier_overlay',
    'official_registry_match',
    'official_directory_match',
    'search_result_review',
  ];
}

export function publishedWebsite(value: string | null | undefined): SpineSourceRecord['website'] {
  const publishedValue = clean(value);
  if (publishedValue === null || /^n\/?a$/i.test(publishedValue)) return null;
  const withScheme = /^https?:\/\//i.test(publishedValue)
    ? publishedValue
    : `https://${publishedValue}`;
  const canonicalUrl = canonicalizeUrl(withScheme);
  if (canonicalUrl === null) return null;
  const primaryDomain = domainOf(canonicalUrl);
  return primaryDomain === null ? null : { publishedValue, canonicalUrl, primaryDomain };
}

export function ncesLeaRecord(row: Record<string, string>): SpineSourceRecord | null {
  const id = clean(row['LEAID']);
  const name = clean(row['LEA_NAME']);
  if (id === null || name === null) return null;
  const state = clean(row['ST']);
  return {
    schemaVersion: 1,
    sourceKey: 'nces-ccd-lea-directory-2024-25',
    sourceRecordKey: id,
    sourceEffectiveDate: isoDate(row['EFFECTIVE_DATE']),
    name,
    nameNormalized: normalizeOrganizationName(name, []),
    organizationTypeCode: ncesLeaType(row['LEA_TYPE'], row['LEA_TYPE_TEXT']),
    governmentLevelCode: null,
    sectorCode: 'education',
    classificationReviewReason:
      'Government level must come from an authoritative constitution or Census government-unit crosswalk.',
    identifiers: compactIdentifiers([
      identifier('nces_district_id', id, null),
      identifier('state_education_org_id', row['ST_LEAID'], state),
    ]),
    parentIdentifiers: [],
    location: {
      addressLine1: clean(row['LSTREET1']),
      addressLine2: joinAddress(row['LSTREET2'], row['LSTREET3']),
      city: clean(row['LCITY']),
      stateCode: clean(row['LSTATE']) ?? state,
      postalCode: joinZip(row['LZIP'], row['LZIP4']),
      countyName: null,
      countyFips: null,
    },
    website: publishedWebsite(row['WEBSITE']),
    attributes: compactAttributes({
      schoolYear: clean(row['SCHOOL_YEAR']),
      status: clean(row['UPDATED_STATUS_TEXT']) ?? clean(row['SY_STATUS_TEXT']),
      leaTypePublished: clean(row['LEA_TYPE_TEXT']),
      charterStatus: clean(row['CHARTER_LEA_TEXT']),
      lowGrade: clean(row['GSLO']),
      highGrade: clean(row['GSHI']),
      operationalSchools: numeric(row['OPERATIONAL_SCHOOLS']),
    }),
  };
}

export function ncesSchoolRecord(row: Record<string, string>): SpineSourceRecord | null {
  const id = clean(row['NCESSCH']);
  const parentId = clean(row['LEAID']);
  const name = clean(row['SCH_NAME']);
  if (id === null || parentId === null || name === null) return null;
  const state = clean(row['ST']);
  return {
    schemaVersion: 1,
    sourceKey: 'nces-ccd-school-directory-2024-25',
    sourceRecordKey: id,
    sourceEffectiveDate: isoDate(row['EFFECTIVE_DATE']),
    name,
    nameNormalized: normalizeOrganizationName(name, []),
    organizationTypeCode: 'school',
    governmentLevelCode: null,
    sectorCode: 'education',
    classificationReviewReason: 'Inherit government level only after the parent LEA is classified.',
    identifiers: compactIdentifiers([
      identifier('nces_school_id', id, null),
      identifier('state_education_org_id', row['ST_SCHID'], state),
    ]),
    parentIdentifiers: [identifier('nces_district_id', parentId, null)],
    location: {
      addressLine1: clean(row['LSTREET1']),
      addressLine2: joinAddress(row['LSTREET2'], row['LSTREET3']),
      city: clean(row['LCITY']),
      stateCode: clean(row['LSTATE']) ?? state,
      postalCode: joinZip(row['LZIP'], row['LZIP4']),
      countyName: null,
      countyFips: null,
    },
    website: publishedWebsite(row['WEBSITE']),
    attributes: compactAttributes({
      schoolYear: clean(row['SCHOOL_YEAR']),
      status: clean(row['UPDATED_STATUS_TEXT']) ?? clean(row['SY_STATUS_TEXT']),
      schoolTypePublished: clean(row['SCH_TYPE_TEXT']),
      charterStatus: clean(row['CHARTER_TEXT']),
      lowGrade: clean(row['GSLO']),
      highGrade: clean(row['GSHI']),
      levelPublished: clean(row['LEVEL']),
    }),
  };
}

export function texasDistrictOverlay(row: Record<string, string>): SpineSourceRecord | null {
  const id = unquote(row['District Number']);
  const name = clean(row['District Name']);
  if (id === null || name === null) return null;
  return {
    schemaVersion: 1,
    sourceKey: 'texas-askted-site-2026',
    sourceRecordKey: `district:${id}`,
    sourceEffectiveDate: isoDate(row['Update Date']),
    name,
    nameNormalized: normalizeOrganizationName(name, []),
    organizationTypeCode: 'school_district',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    classificationReviewReason: null,
    identifiers: compactIdentifiers([
      identifier('state_education_org_id', id, 'TX'),
      identifier('nces_district_id', unquote(row['NCES District ID']), null),
    ]),
    parentIdentifiers: [],
    location: {
      addressLine1: clean(row['District Site Street Address']),
      addressLine2: null,
      city: clean(row['District Site City']),
      stateCode: clean(row['District Site State']) ?? 'TX',
      postalCode: clean(row['District Site Zip']),
      countyName: clean(row['County Name']),
      countyFips: null,
    },
    website: publishedWebsite(row['District Web Page Address']),
    attributes: compactAttributes({
      districtTypePublished: clean(row['District Type']),
      enrollment: numeric(row['District Enrollment as of Oct 2025']),
      enrollmentAsOf: '2025-10',
    }),
  };
}

export function texasSchoolOverlay(row: Record<string, string>): SpineSourceRecord | null {
  const id = unquote(row['School Number']);
  const districtId = unquote(row['District Number']);
  const name = clean(row['School Name']);
  if (id === null || districtId === null || name === null) return null;
  return {
    schemaVersion: 1,
    sourceKey: 'texas-askted-site-2026',
    sourceRecordKey: `school:${id}`,
    sourceEffectiveDate: isoDate(row['Update Date']),
    name,
    nameNormalized: normalizeOrganizationName(name, []),
    organizationTypeCode: 'school',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    classificationReviewReason: null,
    identifiers: compactIdentifiers([
      identifier('state_education_org_id', id, 'TX'),
      identifier('nces_school_id', unquote(row['NCES School ID']), null),
    ]),
    parentIdentifiers: compactIdentifiers([
      identifier('state_education_org_id', districtId, 'TX'),
      identifier('nces_district_id', unquote(row['NCES District ID']), null),
    ]),
    location: {
      addressLine1: clean(row['School Site Street Address']),
      addressLine2: null,
      city: clean(row['School Site City']),
      stateCode: clean(row['School Site State']) ?? 'TX',
      postalCode: clean(row['School Site Zip']),
      countyName: clean(row['County Name']),
      countyFips: null,
    },
    website: publishedWebsite(row['School Web Page Address']),
    attributes: compactAttributes({
      instructionType: clean(row['Instruction Type']),
      charterType: clean(row['Charter Type']),
      magnetStatus: clean(row['Magnet Status']),
      virtualStatus: clean(row['Virtual/Hybrid Campus']),
      gradeRange: clean(row['Grade Range']),
      enrollment: numeric(row['School Enrollment as of Oct 2025']),
      enrollmentAsOf: '2025-10',
      status: clean(row['School Status']),
      statusDate: isoDate(row['School Status Date']),
    }),
  };
}

export function websiteQueueRecord(record: SpineSourceRecord): WebsiteResolutionQueueRecord | null {
  if (record.website !== null) return null;
  return {
    sourceKey: record.sourceKey,
    sourceRecordKey: record.sourceRecordKey,
    name: record.name,
    identifiers: record.identifiers,
    city: record.location.city,
    stateCode: record.location.stateCode,
    postalCode: record.location.postalCode,
    nextStages: [
      'exact_identifier_overlay',
      'official_registry_match',
      'official_directory_match',
      'search_result_review',
    ],
  };
}

function ncesLeaType(code: string | undefined, value: string | undefined): string {
  const normalizedCode = clean(code);
  const normalized = clean(value)?.toLowerCase() ?? '';
  if (normalizedCode === '3' || normalizedCode === '4') return 'education_service_agency';
  if (normalizedCode === '5' || normalized.includes('state agency'))
    return 'state_education_agency';
  return 'school_district';
}

function identifier(
  systemCode: string,
  value: string | null | undefined,
  issuingStateCode: string | null,
): SpineIdentifier {
  return { systemCode, value: unquote(value) ?? '', issuingStateCode };
}

function compactIdentifiers(values: SpineIdentifier[]): SpineIdentifier[] {
  return values.filter((value) => value.value.length > 0);
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length === 0 ? null : normalized;
}

function unquote(value: string | null | undefined): string | null {
  return clean(value)?.replace(/^'/, '') ?? null;
}

function numeric(value: string | null | undefined): number | null {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function joinAddress(second: string | undefined, third: string | undefined): string | null {
  const values = [clean(second), clean(third)].filter((value): value is string => value !== null);
  return values.length === 0 ? null : values.join(', ');
}

function joinZip(zip: string | undefined, zip4: string | undefined): string | null {
  const first = clean(zip);
  const second = clean(zip4);
  if (first === null) return null;
  return second === null ? first : `${first}-${second}`;
}

function compactAttributes(
  input: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}
