/**
 * Minimal, dependency-free RFC 4180 CSV writer.
 *
 * Written by hand rather than pulled from a library so the quoting rules are
 * visible and testable: a mangled quote in an exported file is a data-integrity
 * bug, not a formatting preference.
 */
export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.length === 0) return '';
  const needsQuoting = /[",\r\n]/.test(text) || text !== text.trim();
  const escaped = text.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

export function csvRow(values: readonly (string | number | boolean | null | undefined)[]): string {
  return values.map(csvEscape).join(',');
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

export function renderCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [csvRow(columns.map((column) => column.header))];
  for (const row of rows) lines.push(csvRow(columns.map((column) => column.value(row))));
  return `${lines.join('\r\n')}\r\n`;
}
