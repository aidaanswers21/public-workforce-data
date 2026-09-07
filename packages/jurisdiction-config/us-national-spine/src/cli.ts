#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { parseDelimitedObjects } from '@public-workforce/jurisdiction-kit';
import {
  ncesLeaRecord,
  ncesSchoolRecord,
  publishedWebsite,
  texasDistrictOverlay,
  texasSchoolOverlay,
  websiteQueueRecord,
  type SpineIdentifier,
  type SpineSourceRecord,
} from './index.js';

interface Counter {
  records: number;
  websites: number;
  missingWebsites: number;
}

interface Summary {
  generatedAt: string;
  inputDirectory: string;
  outputDirectory: string;
  sources: Record<string, Counter>;
  geographies: Record<string, number>;
  exactWebsiteOverlays: number;
  reconciliationRequired: number;
  classificationWork: number;
  notes: string[];
}

const inputDirectory = resolve(process.argv[2] ?? '.context/national-spine');
const outputDirectory = resolve(process.argv[3] ?? join(inputDirectory, 'organized'));
const extracted = join(inputDirectory, 'extracted');
const downloads = join(inputDirectory, 'downloads');

for (const required of [
  join(extracted, 'ccd_lea_029_2425.csv'),
  join(extracted, 'ccd_sch_029_2425.csv'),
  join(extracted, 'census-2025', 'Govt_Units_2025_Final.xlsx'),
  join(downloads, 'texas', 'askted-school-district-site.csv'),
]) {
  if (!existsSync(required)) throw new Error(`national spine input is missing: ${required}`);
}

mkdirSync(outputDirectory, { recursive: true });
const organizations = createWriteStream(
  join(outputDirectory, 'organization-source-records.ndjson'),
);
const overlays = createWriteStream(join(outputDirectory, 'organization-overlays.ndjson'));
const websiteQueue = createWriteStream(join(outputDirectory, 'website-resolution-queue.ndjson'));
const websiteOverlays = createWriteStream(
  join(outputDirectory, 'exact-identifier-website-overlays.ndjson'),
);
const relationships = createWriteStream(join(outputDirectory, 'organization-relationships.ndjson'));
const geographies = createWriteStream(join(outputDirectory, 'geographic-areas.ndjson'));
const reconciliation = createWriteStream(join(outputDirectory, 'reconciliation-required.ndjson'));
const classificationWork = createWriteStream(join(outputDirectory, 'classification-work.ndjson'));

const summary: Summary = {
  generatedAt: new Date().toISOString(),
  inputDirectory,
  outputDirectory,
  sources: {},
  geographies: {},
  exactWebsiteOverlays: 0,
  reconciliationRequired: 0,
  classificationWork: 0,
  notes: [
    'Files contain source records, not guessed canonical merges.',
    'Exact shared identifiers are the only automatic merge keys.',
    'NCES LEA government level remains null until an authoritative constitution or Census crosswalk establishes it.',
    'Federal Register entries remain in reconciliation-required until linked to the authoritative federal hierarchy.',
    'No employee or student-level fields are read from the source files.',
  ],
};

const texasWebsites = new Map<string, SpineSourceRecord['website']>();
await organizeTexas();
await organizeNces();
await organizeCensus();
await organizeGeographies();
await organizeUsaGov();
await organizeFederalRegister();

await Promise.all(
  [
    organizations,
    overlays,
    websiteQueue,
    websiteOverlays,
    relationships,
    geographies,
    reconciliation,
    classificationWork,
  ].map(async (stream) => {
    stream.end();
    await once(stream, 'finish');
  }),
);

const summaryPath = join(outputDirectory, 'summary.json');
await writeText(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function organizeTexas(): Promise<void> {
  const path = join(downloads, 'texas', 'askted-school-district-site.csv');
  const seenDistricts = new Set<string>();
  for await (const row of parseDelimitedObjects(createReadStream(path))) {
    const district = texasDistrictOverlay(row);
    if (district !== null && !seenDistricts.has(district.sourceRecordKey)) {
      seenDistricts.add(district.sourceRecordKey);
      await emitSourceRecord(overlays, district, false);
      indexTexasWebsite(district);
    }
    const school = texasSchoolOverlay(row);
    if (school !== null) {
      await emitSourceRecord(overlays, school, false);
      indexTexasWebsite(school);
    }
  }
}

function indexTexasWebsite(record: SpineSourceRecord): void {
  if (record.website === null) return;
  for (const item of record.identifiers) {
    if (item.systemCode.startsWith('nces_')) {
      texasWebsites.set(`${item.systemCode}:${item.value}`, record.website);
    }
  }
}

async function organizeNces(): Promise<void> {
  const leaEnrollment = await loadMetric(
    join(extracted, 'ccd_lea_052_2425_totals.csv'),
    'LEAID',
    'STUDENT_COUNT',
  );
  const leaStaff = await loadMetric(
    join(extracted, 'ccd_lea_059_2425_totals.csv'),
    'LEAID',
    'STAFF_COUNT',
  );
  const leaTeachers = await loadMetric(
    join(extracted, 'ccd_lea_059_2425_teachers.csv'),
    'LEAID',
    'STAFF_COUNT',
  );
  const schoolEnrollment = await loadMetric(
    join(extracted, 'ccd_sch_052_2425_totals.csv'),
    'NCESSCH',
    'STUDENT_COUNT',
  );
  const schoolTeachers = await loadMetric(
    join(extracted, 'ccd_sch_059_2425_totals.csv'),
    'NCESSCH',
    'TEACHERS',
  );
  await organizeNcesFile(join(extracted, 'ccd_lea_029_2425.csv'), ncesLeaRecord, {
    enrollment: leaEnrollment,
    totalStaffFte: leaStaff,
    teacherFte: leaTeachers,
  });
  await organizeNcesFile(join(extracted, 'ccd_sch_029_2425.csv'), ncesSchoolRecord, {
    enrollment: schoolEnrollment,
    teacherFte: schoolTeachers,
  });
}

async function organizeNcesFile(
  path: string,
  mapper: (row: Record<string, string>) => SpineSourceRecord | null,
  metrics: Record<string, Map<string, { value: number | null; publicationState: string | null }>>,
): Promise<void> {
  for await (const row of parseDelimitedObjects(createReadStream(path))) {
    const record = mapper(row);
    if (record === null) continue;
    for (const [code, values] of Object.entries(metrics)) {
      const metric = values.get(record.sourceRecordKey);
      if (metric === undefined) continue;
      record.attributes[code] = metric.value;
      record.attributes[`${code}PublicationState`] = metric.publicationState;
      record.attributes[`${code}AsOf`] = '2024-2025';
    }
    await emitSourceRecord(organizations, record, false);
    for (const parent of record.parentIdentifiers) await emitRelationship(record, parent);
    if (record.website === null) {
      const exact = record.identifiers
        .filter((item) => item.systemCode.startsWith('nces_'))
        .map((item) => ({ item, website: texasWebsites.get(`${item.systemCode}:${item.value}`) }))
        .find((entry) => entry.website !== undefined);
      if (exact?.website !== undefined) {
        await writeLine(websiteOverlays, {
          organizationIdentifier: exact.item,
          website: exact.website,
          method: 'official_identifier_overlay',
          sourceKey: 'texas-askted-site-2026',
        });
        summary.exactWebsiteOverlays += 1;
      } else {
        await emitWebsiteQueue(record);
      }
    }
  }
}

async function loadMetric(
  path: string,
  idColumn: string,
  valueColumn: string,
): Promise<Map<string, { value: number | null; publicationState: string | null }>> {
  const result = new Map<string, { value: number | null; publicationState: string | null }>();
  for await (const row of parseDelimitedObjects(createReadStream(path))) {
    const id = clean(row[idColumn]);
    if (id === null) continue;
    result.set(id, {
      value: numeric(row[valueColumn]),
      publicationState: clean(row['DMS_FLAG']),
    });
  }
  return result;
}

async function organizeCensus(): Promise<void> {
  const workbook = join(extracted, 'census-2025', 'Govt_Units_2025_Final.xlsx');
  const strings = sharedStrings(zipText(workbook, 'xl/sharedStrings.xml'));
  const sheetKinds = [
    'general_purpose',
    'special_district',
    'independent_school_district',
    'dependent_school_system',
    'public_pension_system',
  ] as const;
  for (let index = 0; index < sheetKinds.length; index += 1) {
    const rows = xlsxRows(zipText(workbook, `xl/worksheets/sheet${index + 1}.xml`), strings);
    let header: string[] | null = null;
    for (const values of rows) {
      if (header === null) {
        header = values;
        continue;
      }
      const record = censusRecord(objectFromRow(header, values), sheetKinds[index] as string);
      if (record === null) continue;
      await emitSourceRecord(organizations, record, true);
      for (const parent of record.parentIdentifiers) await emitRelationship(record, parent);
    }
  }
}

function censusRecord(row: Record<string, string>, kind: string): SpineSourceRecord | null {
  const id = clean(row['CENSUS_ID_PID6']);
  const name = clean(row['UNIT_NAME']);
  if (id === null || name === null) return null;
  const rawType = clean(row['UNIT_TYPE']);
  const classification = censusClassification(kind, rawType);
  const stateFips = clean(row['FIPS_STATE']);
  const countyPart = clean(row['FIPS_COUNTY']);
  const parentId = clean(row['PARENT_CENSUS_ID_PID6']);
  return {
    schemaVersion: 1,
    sourceKey: `census-government-units-2025:${kind}`,
    sourceRecordKey: id,
    sourceEffectiveDate: '2025-01-01',
    name,
    nameNormalized: normalizeSimpleName(name),
    organizationTypeCode: classification.organizationTypeCode,
    governmentLevelCode: classification.governmentLevelCode,
    sectorCode: classification.sectorCode,
    classificationReviewReason: classification.reviewReason,
    identifiers: [identifier('census_government_id', id, clean(row['STATE']))],
    parentIdentifiers:
      parentId === null ? [] : [identifier('census_government_id', parentId, clean(row['STATE']))],
    location: {
      addressLine1: clean(row['ADDRESS1']),
      addressLine2: clean(row['ADDRESS2']),
      city: clean(row['CITY']),
      stateCode: clean(row['STATE']),
      postalCode: joinPostal(row['ZIP'], row['ZIP4']),
      countyName: clean(row['COUNTY_AREA_NAME']),
      countyFips:
        stateFips === null || countyPart === null
          ? null
          : `${stateFips.padStart(2, '0')}${countyPart.padStart(3, '0')}`,
    },
    website: publishedWebsite(row['WEB_ADDRESS']),
    attributes: compact({
      unitTypePublished: rawType,
      functionPublished: clean(row['FUNCTION_NAME']),
      activityPublished: clean(row['ACTIVITY_NAME']),
      politicalCodeDescription: clean(row['POLITICAL_CODE_DESCRIPTION']),
      activePublished: clean(row['ACTIVE']),
      population: numeric(row['POPULATION']),
      populationYear: numeric(row['POPULATION_SOURCE_YEAR']),
      enrollment: numeric(row['SCHOOL_ENROLLMENT']),
      enrollmentYear: numeric(row['ENROLLMENT_YEAR']),
      schoolLevelPublished: clean(row['SCHOOL_LEVEL_DESCRIPTION']),
    }),
  };
}

function censusClassification(
  kind: string,
  rawType: string | null,
): {
  organizationTypeCode: string;
  governmentLevelCode: string;
  sectorCode: string | null;
  reviewReason: string | null;
} {
  const level = rawType?.startsWith('0')
    ? 'state'
    : rawType?.startsWith('1')
      ? 'county'
      : rawType?.startsWith('2')
        ? 'municipal'
        : rawType?.startsWith('3')
          ? 'township'
          : 'special_district';
  if (kind === 'special_district') {
    return {
      organizationTypeCode: 'special_district',
      governmentLevelCode: 'special_district',
      sectorCode: null,
      reviewReason: 'Map the published function through the controlled sector taxonomy.',
    };
  }
  if (kind === 'independent_school_district') {
    return {
      organizationTypeCode: 'school_district',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      reviewReason: null,
    };
  }
  if (kind === 'dependent_school_system') {
    return {
      organizationTypeCode: 'school_district',
      governmentLevelCode: level,
      sectorCode: 'education',
      reviewReason: null,
    };
  }
  if (kind === 'public_pension_system') {
    return {
      organizationTypeCode: 'other_public_body',
      governmentLevelCode: level,
      sectorCode: 'finance_revenue',
      reviewReason: 'Review organization type before canonical load; parent linkage is exact.',
    };
  }
  return {
    organizationTypeCode:
      level === 'county'
        ? 'county_government'
        : level === 'municipal'
          ? 'municipality'
          : 'township_government',
    governmentLevelCode: level,
    sectorCode: 'general_government',
    reviewReason: null,
  };
}

async function organizeGeographies(): Promise<void> {
  const inputs: Record<string, string> = {
    '2025_Gaz_state_national.zip': 'state',
    '2025_Gaz_counties_national.zip': 'county',
    '2025_Gaz_cousubs_national.zip': 'county_subdivision',
    '2025_Gaz_place_national.zip': 'census_place',
    '2025_Gaz_elsd_national.zip': 'elementary_school_district_area',
    '2025_Gaz_scsd_national.zip': 'secondary_school_district_area',
    '2025_Gaz_unsd_national.zip': 'unified_school_district_area',
    '2025_Gaz_sdadm_national.zip': 'school_district_administrative_area',
  };
  for (const [file, areaTypeCode] of Object.entries(inputs)) {
    const path = join(downloads, 'geography', file);
    const member = zipMembers(path)[0];
    if (member === undefined) throw new Error(`empty geography archive: ${path}`);
    const rows = zipText(path, member).trim().split(/\r?\n/);
    const header = rows.shift()?.split('|') ?? [];
    let count = 0;
    for (const line of rows) {
      const row = objectFromRow(header, line.split('|'));
      const effectiveAreaType =
        areaTypeCode === 'state' && ['60', '66', '69', '72', '78'].includes(row['GEOID'] ?? '')
          ? 'territory'
          : areaTypeCode;
      await writeLine(geographies, {
        schemaVersion: 1,
        sourceKey: `census-gazetteer-2025:${areaTypeCode}`,
        areaTypeCode: effectiveAreaType,
        geoid: clean(row['GEOID']),
        geoidFullyQualified: clean(row['GEOIDFQ']),
        ansiCode: clean(row['ANSICODE']),
        name: clean(row['NAME']),
        stateCode: clean(row['USPS']),
        landSquareMiles: numeric(row['ALAND_SQMI']),
        waterSquareMiles: numeric(row['AWATER_SQMI']),
        latitude: numeric(row['INTPTLAT']),
        longitude: numeric(row['INTPTLONG']),
      });
      count += 1;
    }
    summary.geographies[areaTypeCode] = count;
  }
}

async function organizeUsaGov(): Promise<void> {
  const directory = join(downloads, 'federal-register');
  for (const letter of 'abcdefghijklmnoprstuvw') {
    const path = join(directory, `usa-gov-agency-index-${letter}.html`);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    const blocks = html.split('<h2 class="usa-accordion__heading">').slice(1);
    for (const block of blocks) {
      const nodeId = block.match(/data-node-id="(\d+)"/)?.[1];
      const button = block.match(/<button[\s\S]*?>([\s\S]*?)<\/button>/)?.[1];
      const website = block.match(/field--name-field-website[\s\S]*?<a href="([^"]+)"/)?.[1];
      if (nodeId === undefined || button === undefined) continue;
      const name = textContent(button);
      if (name.length === 0) continue;
      const record: SpineSourceRecord = {
        schemaVersion: 1,
        sourceKey: 'usagov-agency-index-2026',
        sourceRecordKey: nodeId,
        sourceEffectiveDate: null,
        name,
        nameNormalized: normalizeSimpleName(name),
        organizationTypeCode: 'federal_agency',
        governmentLevelCode: 'federal',
        sectorCode: 'general_government',
        classificationReviewReason:
          'Review component type when linked to the authoritative hierarchy.',
        identifiers: [identifier('usagov_agency_node_id', nodeId, null)],
        parentIdentifiers: [],
        location: emptyLocation(),
        website: publishedWebsite(website),
        attributes: {},
      };
      await emitSourceRecord(organizations, record, true);
    }
  }
}

async function organizeFederalRegister(): Promise<void> {
  const path = join(downloads, 'federal-register', 'agencies.json');
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  for (const row of rows) {
    const id = scalarText(row['id']);
    const name = scalarText(row['name']).trim();
    if (id.length === 0 || name.length === 0) continue;
    const parentId = row['parent_id'] == null ? null : scalarText(row['parent_id']);
    const record: SpineSourceRecord = {
      schemaVersion: 1,
      sourceKey: 'federal-register-agencies-api-2026',
      sourceRecordKey: id,
      sourceEffectiveDate: null,
      name,
      nameNormalized: normalizeSimpleName(name),
      organizationTypeCode: 'federal_agency',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      classificationReviewReason:
        'This regulatory-publication index must be linked to the authoritative federal hierarchy before canonical load.',
      identifiers: [identifier('federal_register_agency_id', id, null)],
      parentIdentifiers:
        parentId === null ? [] : [identifier('federal_register_agency_id', parentId, null)],
      location: emptyLocation(),
      website: publishedWebsite(typeof row['agency_url'] === 'string' ? row['agency_url'] : null),
      attributes: compact({
        slug: typeof row['slug'] === 'string' ? row['slug'] : null,
        shortName: typeof row['short_name'] === 'string' ? row['short_name'] : null,
        federalRegisterUrl: typeof row['url'] === 'string' ? row['url'] : null,
      }),
    };
    await writeLine(reconciliation, record);
    await emitClassificationWork(record);
    summary.reconciliationRequired += 1;
    count(record, false);
  }
}

async function emitSourceRecord(
  stream: NodeJS.WritableStream,
  record: SpineSourceRecord,
  queueMissing: boolean,
): Promise<void> {
  await writeLine(stream, record);
  count(record, true);
  await emitClassificationWork(record);
  if (queueMissing) await emitWebsiteQueue(record);
}

async function emitClassificationWork(record: SpineSourceRecord): Promise<void> {
  if (
    record.classificationReviewReason === null &&
    record.organizationTypeCode !== null &&
    record.governmentLevelCode !== null &&
    record.sectorCode !== null
  ) {
    return;
  }
  const stage =
    record.governmentLevelCode === null && record.parentIdentifiers.length > 0
      ? 'inherit_parent_government_level'
      : record.governmentLevelCode === null
        ? 'authoritative_government_level_crosswalk'
        : record.sectorCode === null
          ? 'controlled_sector_mapping'
          : 'hierarchy_or_type_review';
  await writeLine(classificationWork, {
    sourceKey: record.sourceKey,
    sourceRecordKey: record.sourceRecordKey,
    identifiers: record.identifiers,
    stage,
    reason: record.classificationReviewReason,
  });
  summary.classificationWork += 1;
}

async function emitWebsiteQueue(record: SpineSourceRecord): Promise<void> {
  const queued = websiteQueueRecord(record);
  if (queued !== null) await writeLine(websiteQueue, queued);
}

async function emitRelationship(record: SpineSourceRecord, parent: SpineIdentifier): Promise<void> {
  await writeLine(relationships, {
    sourceKey: record.sourceKey,
    childIdentifiers: record.identifiers,
    parentIdentifier: parent,
    relationshipTypeCode: 'part_of',
  });
}

function count(record: SpineSourceRecord, _sourceRecord: boolean): void {
  const counter = (summary.sources[record.sourceKey] ??= {
    records: 0,
    websites: 0,
    missingWebsites: 0,
  });
  counter.records += 1;
  if (record.website === null) counter.missingWebsites += 1;
  else counter.websites += 1;
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain');
}

function zipText(archive: string, member: string): string {
  return execFileSync('unzip', ['-p', archive, member], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function zipMembers(archive: string): string[] {
  return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textContent(match[1] ?? ''));
}

function* xlsxRows(xml: string, strings: readonly string[]): Generator<string[]> {
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cell[1] ?? '';
      const column = attributes.match(/r="([A-Z]+)/)?.[1];
      if (column === undefined) continue;
      const raw = cell[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      row[columnIndex(column)] = /t="s"/.test(attributes)
        ? (strings[Number(raw)] ?? '')
        : textContent(raw);
    }
    yield row;
  }
}

function columnIndex(column: string): number {
  let value = 0;
  for (const char of column) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function objectFromRow(
  header: readonly string[],
  values: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < header.length; index += 1) {
    const key = header[index];
    if (key !== undefined) result[key] = values[index] ?? '';
  }
  return result;
}

function textContent(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSimpleName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function identifier(
  systemCode: string,
  value: string,
  issuingStateCode: string | null,
): SpineIdentifier {
  return { systemCode, value, issuingStateCode };
}

function emptyLocation(): SpineSourceRecord['location'] {
  return {
    addressLine1: null,
    addressLine2: null,
    city: null,
    stateCode: null,
    postalCode: null,
    countyName: null,
    countyFips: null,
  };
}

function compact(
  input: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

function clean(value: string | null | undefined): string | null {
  const result = value?.trim() ?? '';
  return result.length === 0 ? null : result;
}

function numeric(value: string | null | undefined): number | null {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

function joinPostal(zip: string | undefined, zip4: string | undefined): string | null {
  const first = clean(zip);
  const second = clean(zip4);
  if (first === null) return null;
  return second === null ? first : `${first}-${second}`;
}

async function writeText(path: string, value: string): Promise<void> {
  const stream = createWriteStream(path);
  stream.end(value);
  await once(stream, 'finish');
}

function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
