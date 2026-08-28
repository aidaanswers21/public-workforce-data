import {
  collapseWhitespace,
  normalizeCountyName,
  normalizeDistrictName,
  normalizeSchoolName,
} from '@pan/core';
import type { ColumnMapping, OfficialSource, StateConfig } from './types.js';

export interface ImportedDistrict {
  name: string;
  nameNormalized: string;
  nameSourceValue: string;
  countyName: string | null;
  countyNameNormalized: string | null;
  stateAgencyId: string | null;
  ncesId: string | null;
  websiteUrl: string | null;
}

export interface ImportedSchool extends ImportedDistrict {
  districtSourceId: string | null;
  schoolLevel: string | null;
  lowGrade: string | null;
  highGrade: string | null;
}

export interface ImportResult {
  districts: ImportedDistrict[];
  schools: ImportedSchool[];
  /** Rows that could not be mapped, kept so an import is never silently lossy. */
  rejected: { row: number; reason: string }[];
}

/**
 * Reads an official institution list into our shape.
 *
 * Implementations are per format, not per state: the state supplies the URL and
 * the column mapping, and the same CSV importer serves every state that
 * publishes a CSV. That is the reuse the onboarding process depends on.
 */
export interface InstitutionImporter {
  readonly key: string;
  readonly format: OfficialSource['format'];
  import(content: string, mapping: ColumnMapping, config: StateConfig): ImportResult;
}

export class UnverifiedSourceError extends Error {
  constructor(source: OfficialSource) {
    super(
      `official source "${source.key}" is not marked verified. ${source.verificationNote} ` +
        'Confirm the URL and column mapping against the real file, then set verified: true.',
    );
    this.name = 'UnverifiedSourceError';
  }
}

/** Refuse to import from a source no human has confirmed. */
export function assertSourceVerified(source: OfficialSource, allowUnverified = false): void {
  if (!source.verified && !allowUnverified) throw new UnverifiedSourceError(source);
}

/**
 * RFC 4180 CSV reader.
 *
 * Handles quoted fields containing separators and newlines, which government
 * exports produce whenever a district name has a comma in it.
 */
export function parseCsv(content: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const body = content.replace(/^\uFEFF/, '');
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

/**
 * Turns a delimited official file into district and school records.
 *
 * County names are normalized through the state's alias table, source values
 * are preserved verbatim, and any row missing a district name is rejected with
 * a reason rather than dropped.
 */
export class DelimitedInstitutionImporter implements InstitutionImporter {
  readonly key = 'delimited';

  constructor(readonly format: OfficialSource['format'] = 'csv') {}

  import(content: string, mapping: ColumnMapping, config: StateConfig): ImportResult {
    const delimiter = this.format === 'tsv' ? '\t' : ',';
    const rows = parseCsv(content, delimiter);
    const header = rows[0];
    const result: ImportResult = { districts: [], schools: [], rejected: [] };
    if (header === undefined) return result;

    const columnIndex = new Map(
      header.map((name, index) => [collapseWhitespace(name).toLowerCase(), index]),
    );
    const at = (row: string[], column: string | undefined): string | null => {
      if (column === undefined) return null;
      const index = columnIndex.get(column.toLowerCase());
      if (index === undefined) return null;
      const value = collapseWhitespace(row[index] ?? '');
      return value.length === 0 ? null : value;
    };

    const seenDistricts = new Set<string>();

    for (let rowNumber = 1; rowNumber < rows.length; rowNumber += 1) {
      const row = rows[rowNumber] as string[];
      const districtName = at(row, mapping.districtName);
      if (districtName === null) {
        result.rejected.push({
          row: rowNumber + 1,
          reason: 'no district name in the mapped column',
        });
        continue;
      }

      const rawCounty = at(row, mapping.countyName);
      const countyName = rawCounty === null ? null : canonicalCounty(rawCounty, config);
      const districtId = at(row, mapping.districtId);

      const district: ImportedDistrict = {
        name: districtName,
        nameNormalized: normalizeDistrictName(districtName),
        nameSourceValue: districtName,
        countyName,
        countyNameNormalized: countyName === null ? null : normalizeCountyName(countyName),
        stateAgencyId: districtId,
        ncesId: at(row, mapping.ncesId),
        websiteUrl: at(row, mapping.websiteUrl),
      };

      const districtKey = district.stateAgencyId ?? district.nameNormalized;
      if (!seenDistricts.has(districtKey)) {
        seenDistricts.add(districtKey);
        result.districts.push(district);
      }

      const schoolName = at(row, mapping.schoolName);
      if (schoolName === null) continue;
      result.schools.push({
        ...district,
        name: schoolName,
        nameNormalized: normalizeSchoolName(schoolName),
        nameSourceValue: schoolName,
        stateAgencyId: at(row, mapping.schoolId),
        districtSourceId: districtId,
        schoolLevel: at(row, mapping.schoolLevel),
        lowGrade: at(row, mapping.lowGrade),
        highGrade: at(row, mapping.highGrade),
      });
    }

    return result;
  }
}

/** Apply the state's alias table, then the generic county normalizer. */
export function canonicalCounty(raw: string, config: StateConfig): string {
  const normalized = normalizeCountyName(raw);
  const alias = config.countyAliases[normalized.toLowerCase()];
  return alias ?? normalized;
}
