import {
  exportPeopleCsv,
  type ExportPeopleCsvInput,
  type ExportResult,
} from '@public-workforce/core';
import type { Uuid } from '@public-workforce/shared-types';

export interface TexasEducationGradeRange {
  lowGrade: string | null;
  highGrade: string | null;
}

export interface TexasEducationStaffDirectoryExportInput extends Omit<
  ExportPeopleCsvInput,
  'format' | 'roleCategoryFlagCode'
> {
  /** Published education attributes, keyed by the employing organization. */
  gradeRangesByOrganizationId?: ReadonlyMap<Uuid, TexasEducationGradeRange>;
}

/**
 * Applies Texas education presentation rules after the neutral suppression path.
 *
 * The neutral renderer owns suppression and provenance. This wrapper only supplies
 * the education role flag and a published grade range from the sector extension.
 */
export function exportTexasEducationStaffDirectoryCsv(
  input: TexasEducationStaffDirectoryExportInput,
): ExportResult {
  const { gradeRangesByOrganizationId, ...exportInput } = input;
  const rows = exportInput.rows.map((row) => {
    const range =
      row.organizationId === null
        ? undefined
        : gradeRangesByOrganizationId?.get(row.organizationId);
    const gradeRange =
      range === undefined
        ? null
        : [range.lowGrade, range.highGrade].filter((value) => value !== null).join('-') || null;
    return {
      ...row,
      publishedEmails: row.publishedEmails?.map((email) => ({
        ...email,
        gradeRangePublished: email.gradeRangePublished ?? gradeRange,
      })),
    };
  });
  const result = exportPeopleCsv({
    ...exportInput,
    rows,
    format: 'staff_directory',
    roleCategoryFlagCode: 'teacher',
    roleCategoryFlagHeader: 'is_teacher',
  });
  return result;
}
