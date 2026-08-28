import { describe, expect, it } from 'vitest';
import { looksLikeTitle, normalizeTitle } from './titles.js';

describe('normalizeTitle', () => {
  it('returns unknown for a missing title rather than guessing', () => {
    const result = normalizeTitle(null);
    expect(result.roleCategory).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.titleNormalized).toBe('');
  });

  it.each([
    ['Superintendent', 'superintendent', 'executive'],
    ['Deputy Superintendent', 'district_leadership', 'executive'],
    ['Principal', 'principal', 'manager'],
    ['Assistant Principal', 'assistant_principal', 'manager'],
    ['4th Grade Teacher', 'teacher', 'staff'],
    ['School Counselor', 'counselor', 'staff'],
    ['Head Custodian', 'custodial', 'support'],
    ['Bus Driver', 'transportation', 'support'],
    ['Cafeteria Manager', 'food_service', 'support'],
    ['Paraprofessional', 'paraprofessional', 'support'],
    ['Athletic Director', 'coach_athletics', 'director'],
    ['Head Football Coach', 'coach_athletics', 'staff'],
    ['Library Media Specialist', 'librarian_media', 'staff'],
    ['School Nurse', 'nurse_health', 'staff'],
    ['Network Administrator', 'technology', 'staff'],
    ['Payroll Clerk', 'human_resources', 'staff'],
    ['Board President', 'board_member', 'executive'],
    ['Special Education Diagnostician', 'special_education', 'staff'],
    ['Orchestra Director', 'fine_arts', 'staff'],
    ['Attendance Clerk', 'administrative_support', 'support'],
  ])('classifies %s as %s', (title, category, seniority) => {
    const result = normalizeTitle(title);
    expect(result.roleCategory).toBe(category);
    expect(result.seniority).toBe(seniority);
  });

  it('covers support roles, not only decision makers', () => {
    const supportRoles = ['Groundskeeper', 'Substitute Teacher', 'Cafeteria Worker', 'Bus Monitor'];
    for (const role of supportRoles) {
      expect(normalizeTitle(role).roleCategory).not.toBe('unknown');
    }
  });

  it('keeps an unmatched title as other with low confidence instead of dropping it', () => {
    const result = normalizeTitle('Wellness Storyteller');
    expect(result.roleCategory).toBe('other');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.titleNormalized).toBe('Wellness Storyteller');
  });

  it('expands abbreviations and de-shouts', () => {
    expect(normalizeTitle('ASST. PRIN.').titleNormalized).toBe('Assistant Principal');
    expect(normalizeTitle('DIR. OF HR').titleNormalized).toContain('Human Resources');
  });

  it('picks out subject and grade specialties', () => {
    expect(normalizeTitle('Math Teacher').specialty).toBe('Math');
    expect(normalizeTitle('3rd Grade Teacher').specialty).toBe('3rd');
  });

  it('ranks assistant principal above principal so the specific rule wins', () => {
    expect(normalizeTitle('Assistant Principal').roleCategory).toBe('assistant_principal');
    expect(normalizeTitle('Vice Principal').roleCategory).toBe('assistant_principal');
  });
});

describe('looksLikeTitle', () => {
  it('recognizes table header labels', () => {
    expect(looksLikeTitle('Name')).toBe(true);
    expect(looksLikeTitle('Email')).toBe(true);
  });

  it('does not mistake a person name for a title', () => {
    expect(looksLikeTitle('Jane Smith')).toBe(false);
  });
});
