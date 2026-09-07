import {
  collapseWhitespace,
  normalizeCountyName,
  normalizeOrganizationName,
} from '@public-workforce/core';
import type { ColumnMapping, JurisdictionConfig, OfficialSource } from './types.js';

/** One organization as an official file published it. */
export interface ImportedOrganization {
  name: string;
  nameNormalized: string;
  nameSourceValue: string;
  organizationTypeCode: string | null;
  parentName: string | null;
  parentSourceId: string | null;
  countyName: string | null;
  countyNameNormalized: string | null;
  cityName: string | null;
  stateCode: string | null;
  officialId: string | null;
  websiteUrl: string | null;
  /** Sector-specific values, passed through for an extension table to store. */
  extensionValues: Record<string, string>;
}

export interface ImportResult {
  organizations: ImportedOrganization[];
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
export interface ImportOptions {
  /**
   * Import from a source nobody has confirmed.
   *
   * Exists for fixtures and for a deliberate, recorded decision. It defaults to
   * false and has to be written down at the call site, which is the point: an
   * unverified import should be visible in a diff.
   */
  allowUnverified?: boolean;
}

export interface InstitutionImporter {
  readonly key: string;
  readonly format: OfficialSource['format'];
  /**
   * Read an official file.
   *
   * The source is a required argument, not context the caller may forget.
   * Verification used to be a function anyone could call and nobody did, so an
   * unread government file could be imported by writing one line. Now the only
   * way to reach the parser is through a source, and the first thing the parser
   * does is refuse an unverified one.
   */
  import(
    content: string,
    source: OfficialSource,
    mapping: ColumnMapping,
    config: JurisdictionConfig,
    options?: ImportOptions,
  ): ImportResult;
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
 * Streaming form of the same RFC 4180 parser.
 *
 * Bulk public files can contain hundreds of thousands of rows. Callers should
 * not need to hold the entire file in memory merely to normalize one row at a
 * time. Quoted fields, embedded newlines and escaped quotes work across chunk
 * boundaries.
 */
export async function* parseCsvStream(
  chunks: AsyncIterable<string | Uint8Array>,
  delimiter = ',',
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotePending = false;
  let firstChunk = true;

  const completed: string[][] = [];
  const finishField = (): void => {
    row.push(field);
    field = '';
  };
  const finishRow = (): void => {
    finishField();
    if (row.some((cell) => cell.trim().length > 0)) completed.push(row);
    row = [];
  };

  for await (const chunk of chunks) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (firstChunk) {
      text = text.replace(/^\uFEFF/, '');
      firstChunk = false;
    }
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string;
      if (quotePending) {
        quotePending = false;
        if (char === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
      }
      if (inQuotes) {
        if (char === '"') {
          if (index + 1 >= text.length) {
            quotePending = true;
          } else if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"' && field.length === 0) {
        inQuotes = true;
      } else if (char === delimiter) {
        finishField();
      } else if (char === '\n') {
        finishRow();
      } else if (char !== '\r') {
        field += char;
      }
    }
    while (completed.length > 0) yield completed.shift() as string[];
  }

  const tail = decoder.decode();
  if (tail.length > 0) field += tail;
  if (quotePending) inQuotes = false;
  if (inQuotes) throw new Error('unterminated quoted field in delimited source');
  if (field.length > 0 || row.length > 0) finishRow();
  while (completed.length > 0) yield completed.shift() as string[];
}

/** Turn a streamed header and rows into source-preserving objects. */
export async function* parseDelimitedObjects(
  chunks: AsyncIterable<string | Uint8Array>,
  delimiter = ',',
): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  for await (const row of parseCsvStream(chunks, delimiter)) {
    if (header === null) {
      header = row.map((value) => collapseWhitespace(value));
      continue;
    }
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      const key = header[index];
      if (key !== undefined) record[key] = collapseWhitespace(row[index] ?? '');
    }
    yield record;
  }
}

/**
 * Turns a delimited official file into organization records.
 *
 * Works the same for a state agency list, a county department roster and a
 * school directory: the caller supplies the column mapping, and the importer
 * knows nothing about which vertical it is reading. Area names are normalized
 * through the jurisdiction's alias table, source values are preserved verbatim,
 * and any unmappable row is rejected with a reason rather than dropped.
 */
export class DelimitedOrganizationImporter implements InstitutionImporter {
  readonly key = 'delimited';

  constructor(readonly format: OfficialSource['format'] = 'csv') {}

  import(
    content: string,
    source: OfficialSource,
    mapping: ColumnMapping,
    config: JurisdictionConfig,
    options: ImportOptions = {},
  ): ImportResult {
    // Before anything is parsed, and long before anything is written.
    assertSourceVerified(source, options.allowUnverified ?? false);

    const delimiter = this.format === 'tsv' ? '\t' : ',';
    const rows = parseCsv(content, delimiter);
    const header = rows[0];
    const result: ImportResult = { organizations: [], rejected: [] };
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

    const suffixes = organizationNameSuffixes(config);
    const seen = new Set<string>();

    for (let rowNumber = 1; rowNumber < rows.length; rowNumber += 1) {
      const row = rows[rowNumber] as string[];
      const name = at(row, mapping.organizationName);
      if (name === null) {
        result.rejected.push({
          row: rowNumber + 1,
          reason: 'no organization name in the mapped column',
        });
        continue;
      }

      const rawCounty = at(row, mapping.countyName);
      const countyName = rawCounty === null ? null : canonicalAreaName(rawCounty, config);
      const officialId = at(row, mapping.organizationId);

      const extensionValues: Record<string, string> = {};
      for (const [field, column] of Object.entries(mapping.extensionColumns ?? {})) {
        const value = at(row, column);
        if (value !== null) extensionValues[field] = value;
      }

      const organization: ImportedOrganization = {
        name,
        nameNormalized: normalizeOrganizationName(name, suffixes),
        nameSourceValue: name,
        organizationTypeCode: at(row, mapping.organizationTypeCode),
        parentName: at(row, mapping.parentOrganizationName),
        parentSourceId: at(row, mapping.parentOrganizationId),
        countyName,
        countyNameNormalized: countyName === null ? null : normalizeCountyName(countyName),
        cityName: at(row, mapping.cityName),
        stateCode: at(row, mapping.stateCode) ?? config.jurisdiction.stateCode,
        officialId,
        websiteUrl: at(row, mapping.websiteUrl),
        extensionValues,
      };

      // Official identifier first, because names change and identifiers do not.
      const key =
        organization.officialId ??
        `${organization.organizationTypeCode ?? ''}|${organization.nameNormalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.organizations.push(organization);
    }

    return result;
  }
}

/**
 * Suffixes to drop when comparing organization names.
 *
 * Supplied by the caller's composed vocabulary in production. The importer
 * falls back to nothing rather than guessing, so an unconfigured jurisdiction
 * produces conservative keys instead of wrong ones.
 */
function organizationNameSuffixes(config: JurisdictionConfig): readonly string[] {
  const declared = (config as { organizationNameSuffixes?: readonly string[] })
    .organizationNameSuffixes;
  return declared ?? [];
}

/** Apply the jurisdiction's alias table, then the generic area normalizer. */
export function canonicalAreaName(raw: string, config: JurisdictionConfig): string {
  const normalized = normalizeCountyName(raw);
  return config.areaAliases[normalized.toLowerCase()] ?? normalized;
}
