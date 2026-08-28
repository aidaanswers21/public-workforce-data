import type { RoleCategory, SeniorityLevel } from '@pan/shared-types';
import { collapseWhitespace, decaseIfShouting, normalizeKey } from './text.js';

export interface NormalizedTitle {
  /** Cleaned, cased title. Abbreviations expanded, noise removed. */
  titleNormalized: string;
  roleCategory: RoleCategory;
  seniority: SeniorityLevel;
  /** Subject or grade band when the title carries one, e.g. "Math", "3rd Grade". */
  specialty: string | null;
  /** 0..1 confidence in the category assignment. */
  confidence: number;
}

interface TitleRule {
  /** Matched against the hyphen-normalized title key. */
  test: RegExp;
  category: RoleCategory;
  seniority: SeniorityLevel;
  confidence?: number;
}

/**
 * Ordered most specific to least. First match wins, so anything that could be
 * shadowed by a broader rule must appear above it. "Assistant Principal" must
 * precede "Principal"; "Athletic Director" must precede the generic director rule.
 */
const TITLE_RULES: readonly TitleRule[] = [
  {
    test: /\b(deputy|associate|assistant)-superintendent\b/,
    category: 'district_leadership',
    seniority: 'executive',
  },
  { test: /\bsuperintendent\b/, category: 'superintendent', seniority: 'executive' },
  {
    test: /\b(school-)?board-(member|president|trustee|secretary)\b|\btrustee\b/,
    category: 'board_member',
    seniority: 'executive',
  },
  { test: /\b(chief|cfo|cio|cto|coo)\b/, category: 'district_leadership', seniority: 'executive' },

  {
    test: /\b(assistant|associate|vice|asst)-principal\b/,
    category: 'assistant_principal',
    seniority: 'manager',
  },
  { test: /\bprincipal\b/, category: 'principal', seniority: 'manager' },
  { test: /\b(dean|head-of-school)\b/, category: 'school_leadership', seniority: 'manager' },

  {
    test: /\b(athletic|athletics)-(director|coordinator)\b/,
    category: 'coach_athletics',
    seniority: 'director',
  },
  {
    test: /\b(head-)?coach\b|\bathletic-trainer\b/,
    category: 'coach_athletics',
    seniority: 'staff',
  },

  {
    test: /\b(special-education|sped|special-ed|diagnostician|life-skills|resource)\b/,
    category: 'special_education',
    seniority: 'staff',
  },
  {
    test: /\b(speech|slp|occupational-therapist|physical-therapist|audiologist)\b/,
    category: 'special_education',
    seniority: 'staff',
  },

  { test: /\b(counselor|counseling|guidance)\b/, category: 'counselor', seniority: 'staff' },
  { test: /\b(psychologist|lssp)\b/, category: 'psychologist', seniority: 'staff' },
  { test: /\bsocial-worker\b/, category: 'social_worker', seniority: 'staff' },
  {
    test: /\b(nurse|health-(aide|clerk|services)|clinic)\b/,
    category: 'nurse_health',
    seniority: 'staff',
  },
  {
    test: /\b(librarian|library|media-specialist)\b/,
    category: 'librarian_media',
    seniority: 'staff',
  },

  {
    test: /\b(band|choir|orchestra|theatre|theater|art|fine-arts|drama|music)-(director|teacher)\b/,
    category: 'fine_arts',
    seniority: 'staff',
  },

  {
    test: /\b(instructional-(coach|specialist|technologist)|curriculum|academic-coach|interventionist)\b/,
    category: 'instructional_support',
    seniority: 'staff',
  },
  { test: /\b(teacher|instructor|educator|faculty)\b/, category: 'teacher', seniority: 'staff' },

  {
    test: /\b(paraprofessional|para|teacher-(aide|assistant)|instructional-aide)\b/,
    category: 'paraprofessional',
    seniority: 'support',
  },
  { test: /\bsubstitute\b/, category: 'substitute', seniority: 'support' },

  {
    test: /\b(technology|information-technology|network|systems|help-desk|computer)\b/,
    category: 'technology',
    seniority: 'staff',
  },
  {
    test: /\b(human-resources|hr|personnel|talent|benefits|payroll)\b/,
    category: 'human_resources',
    seniority: 'staff',
  },
  {
    test: /\b(finance|business-(office|manager)|accounting|accountant|budget|purchasing|bookkeeper)\b/,
    category: 'finance_business',
    seniority: 'staff',
  },
  {
    test: /\b(communications|public-(information|relations)|marketing|webmaster)\b/,
    category: 'communications',
    seniority: 'staff',
  },
  {
    test: /\b(transportation|bus-(driver|monitor)|fleet)\b/,
    category: 'transportation',
    seniority: 'support',
  },
  {
    test: /\b(child-nutrition|cafeteria|food-service|lunchroom|kitchen)\b/,
    category: 'food_service',
    seniority: 'support',
  },
  {
    test: /\b(custodian|custodial|janitor|groundskeeper)\b/,
    category: 'custodial',
    seniority: 'support',
  },
  {
    test: /\b(maintenance|facilities|operations|warehouse)\b/,
    category: 'operations_facilities',
    seniority: 'support',
  },
  {
    test: /\b(police|resource-officer|sro|security|safety)\b/,
    category: 'safety_security',
    seniority: 'staff',
  },
  {
    test: /\b(volunteer|pta|parent-liaison|community-liaison)\b/,
    category: 'volunteer_community',
    seniority: 'support',
  },

  {
    test: /\b(secretary|receptionist|registrar|clerk|administrative-(assistant|secretary)|office-(manager|staff)|attendance)\b/,
    category: 'administrative_support',
    seniority: 'support',
  },

  {
    test: /\b(executive-director|director)\b/,
    category: 'district_leadership',
    seniority: 'director',
    confidence: 0.7,
  },
  {
    test: /\b(coordinator|supervisor|manager)\b/,
    category: 'district_leadership',
    seniority: 'manager',
    confidence: 0.6,
  },
  {
    test: /\b(specialist|analyst|technician|assistant)\b/,
    category: 'other',
    seniority: 'staff',
    confidence: 0.5,
  },
];

const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\basst\b\.?/gi, 'Assistant'],
  [/\bassoc\b\.?/gi, 'Associate'],
  [/\bdir\b\.?/gi, 'Director'],
  [/\bcoord\b\.?/gi, 'Coordinator'],
  [/\bsupt\b\.?/gi, 'Superintendent'],
  [/\bprin\b\.?/gi, 'Principal'],
  [/\bteach\b\.?/gi, 'Teacher'],
  [/\bsped\b/gi, 'Special Education'],
  [/\bela\b/gi, 'ELA'],
  [/\bpe\b/gi, 'Physical Education'],
  [/\bhr\b/gi, 'Human Resources'],
  [/\bit\b/gi, 'Technology'],
  [/\bsro\b/gi, 'School Resource Officer'],
  [/\bgt\b/gi, 'Gifted and Talented'],
];

const GRADE_PATTERN =
  /\b(pre-?k(?:indergarten)?|kindergarten|k|\d{1,2}(?:st|nd|rd|th))\b(?:\s*(?:-|through|to)\s*\b(\d{1,2}(?:st|nd|rd|th))\b)?/i;

const SUBJECT_PATTERN =
  /\b(math(?:ematics)?|science|biology|chemistry|physics|english|ela|reading|writing|history|social studies|spanish|french|german|latin|art|music|band|choir|orchestra|theatre|theater|computer science|technology|health|physical education|economics|government|geography|algebra|geometry|calculus)\b/i;

/**
 * Normalize a published title and assign a role category.
 *
 * Every staff role is covered, not only decision-makers: an unmatched title
 * becomes `other` with low confidence rather than being dropped, so coverage
 * reporting can surface titles the rule table does not yet know.
 */
export function normalizeTitle(raw: string | null | undefined): NormalizedTitle {
  const cleaned = collapseWhitespace(raw ?? '');
  if (cleaned.length === 0) {
    return {
      titleNormalized: '',
      roleCategory: 'unknown',
      seniority: 'unknown',
      specialty: null,
      confidence: 0,
    };
  }

  let expanded = decaseIfShouting(cleaned);
  for (const [pattern, replacement] of ABBREVIATIONS) {
    expanded = expanded.replace(pattern, replacement);
  }
  expanded = expanded
    .replace(/\s*[/|]\s*/g, ' / ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const key = normalizeKey(expanded);
  const matched = TITLE_RULES.find((rule) => rule.test.test(key));

  const gradeMatch = GRADE_PATTERN.exec(cleaned);
  const subjectMatch = SUBJECT_PATTERN.exec(cleaned);
  const specialty =
    subjectMatch?.[0] !== undefined
      ? decaseIfShouting(subjectMatch[0])
      : gradeMatch?.[0] !== undefined
        ? decaseIfShouting(gradeMatch[0])
        : null;

  if (matched === undefined) {
    return {
      titleNormalized: expanded,
      roleCategory: 'other',
      seniority: 'unknown',
      specialty,
      confidence: 0.2,
    };
  }

  return {
    titleNormalized: expanded,
    roleCategory: matched.category,
    seniority: matched.seniority,
    specialty,
    confidence: matched.confidence ?? 0.9,
  };
}

/**
 * True when a string looks like a job title rather than a person's name.
 * Used to reject header rows and mis-aligned table columns.
 */
export function looksLikeTitle(value: string): boolean {
  const key = normalizeKey(value);
  if (key.length === 0) return false;
  if (/^(name|staff|employee|title|position|email|phone|department)$/.test(key)) return true;
  return TITLE_RULES.some((rule) => rule.test.test(key));
}
