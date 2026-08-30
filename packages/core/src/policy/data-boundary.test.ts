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
