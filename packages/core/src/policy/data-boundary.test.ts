import { describe, expect, it } from 'vitest';
import {
  applyDataBoundary,
  isPersonalEmailDomain,
  scanForProhibitedData,
} from './data-boundary.js';

describe('scanForProhibitedData', () => {
  it.each([
    ['ssn', '123-45-6789', 'government_id_number'],
    ['notes', '123-45-6789', 'government_id_number'],
    ['date_of_birth', '1980-01-01', 'date_of_birth'],
    ['dob', 'anything', 'date_of_birth'],
    ['bank account number', '4111111111111111', 'financial_account'],
    ['diagnosis', 'anything', 'medical'],
    ['home address', '1 Any Street', 'home_address'],
    ['emergency contact', 'someone', 'family_information'],
    ['password', 'anything', 'credential'],
  ])('catches %s as %s', (field, value, kind) => {
    expect(scanForProhibitedData(field, value).map((finding) => finding.kind)).toContain(kind);
  });

  it('allows professional fields through', () => {
    expect(scanForProhibitedData('title_published', 'Program Analyst')).toEqual([]);
    expect(scanForProhibitedData('office_address', '100 Main Street, Suite 200')).toEqual([]);
    expect(scanForProhibitedData('work_phone', '555-010-1001')).toEqual([]);
  });

  it('never repeats the offending value in the finding', () => {
    const [finding] = scanForProhibitedData('ssn', '123-45-6789');
    expect(JSON.stringify(finding)).not.toContain('123-45-6789');
  });
});

describe('isPersonalEmailDomain', () => {
  it.each(['gmail.com', 'YAHOO.COM', 'outlook.com', 'protonmail.com', 'comcast.net'])(
    'recognizes %s as personal',
    (domain) => {
      expect(isPersonalEmailDomain(domain)).toBe(true);
    },
  );

  it.each(['agency.example.gov', 'co.harris.tx.us', 'sample-isd.example.org'])(
    'treats %s as professional',
    (domain) => {
      expect(isPersonalEmailDomain(domain)).toBe(false);
    },
  );
});

describe('applyDataBoundary', () => {
  it('keeps professional fields and drops the rest', () => {
    const result = applyDataBoundary({
      full_name_published: 'Jane Smith',
      title_published: 'Program Analyst',
      home_address: '1 Any Street',
      ssn: '123-45-6789',
      work_phone: '555-010-1001',
    });
    expect(Object.keys(result.allowed).sort()).toEqual([
      'full_name_published',
      'title_published',
      'work_phone',
    ]);
    expect(result.findings.map((finding) => finding.kind).sort()).toEqual([
      'government_id_number',
      'home_address',
    ]);
  });

  it('skips empty values without reporting them', () => {
    const result = applyDataBoundary({ title_published: null, department_published: '' });
    expect(result.allowed).toEqual({});
    expect(result.findings).toEqual([]);
  });

  it('reports what it dropped, so a repeat offender is visible', () => {
    const result = applyDataBoundary({ dob: '1980-01-01' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.field).toBe('dob');
  });
});

/**
 * Student and guardian detection.
 *
 * The hard part is not catching student records. It is catching them without
 * catching the many public employees whose job titles contain the same words,
 * because a boundary that rejects "Director of Student Services" throws away
 * real employees and trains whoever reads the drop counter to ignore it.
 */
describe('student and guardian detection', () => {
  it.each([
    'Director of Student Services',
    'Student Affairs Coordinator',
    'Dean of Students',
    'Student Success Advisor',
    'Assistant Director, Student Life',
    'Guardian ad Litem Coordinator',
    'Parent Liaison',
    'Parent and Family Engagement Specialist',
  ])('keeps the legitimate job title %s', (title) => {
    expect(scanForProhibitedData('title_published', title)).toEqual([]);
    expect(applyDataBoundary({ title_published: title }).allowed['title_published']).toBe(title);
  });

  it.each([
    ['student_name', 'Jamie Fields'],
    ['student_id', '00219384'],
    ['student_email', 'jamie.fields@students.example.org'],
    ['pupil_dob', '03/14/2011'],
    ['name_of_student', 'Jamie Fields'],
    ['learner_record', 'attendance summary'],
  ])('drops the student field %s', (field, value) => {
    const findings = scanForProhibitedData(field, value);
    expect(findings.map((finding) => finding.kind)).toContain('student_information');
    expect(applyDataBoundary({ [field]: value }).allowed[field]).toBeUndefined();
  });

  it.each([
    ['parent_email', 'someone@example.com'],
    ['guardian_name', 'Alex Fields'],
    ['guardian_phone', '555-0100'],
    ['caregiver_contact', 'Alex Fields'],
  ])('drops the guardian field %s', (field, value) => {
    const findings = scanForProhibitedData(field, value);
    expect(findings.map((finding) => finding.kind)).toContain('guardian_information');
  });

  it('drops a value that identifies a student by school position', () => {
    expect(
      scanForProhibitedData('full_name_published', 'Jamie Fields, Class of 2027').map(
        (finding) => finding.kind,
      ),
    ).toContain('student_information');
  });

  it('never reports the offending value, only the field and the reason', () => {
    const findings = scanForProhibitedData('student_id', '00219384');
    for (const finding of findings) {
      expect(finding.reason).not.toContain('00219384');
      expect(JSON.stringify(finding)).not.toContain('00219384');
    }
  });

  it('does not treat the bare word as a signal', () => {
    // Neither of these names a student as the subject of the record.
    expect(scanForProhibitedData('department_published', 'Student Services')).toEqual([]);
    expect(scanForProhibitedData('organization_published', 'Student Health Center')).toEqual([]);
  });
});
