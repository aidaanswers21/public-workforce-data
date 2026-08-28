import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  isShouting,
  normalizeCountyName,
  normalizeDepartmentName,
  normalizeDistrictName,
  normalizeKey,
  normalizePhone,
  normalizeSchoolName,
} from './text.js';

describe('collapseWhitespace', () => {
  it('removes zero-width and exotic space characters', () => {
    expect(collapseWhitespace('Jos​e Garcia')).toBe('Jose Garcia');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(collapseWhitespace('  a \t\n  b  ')).toBe('a b');
  });
});

describe('normalizeKey', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalizeKey('José M. García-López')).toBe('jose-m-garcia-lopez');
  });
});

describe('normalizeCountyName', () => {
  it.each([
    ['Harris', 'Harris'],
    ['Harris County', 'Harris'],
    ['HARRIS CO.', 'Harris'],
    ['County of Harris', 'Harris'],
    ['DeWitt County', 'DeWitt'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCountyName(input)).toBe(expected);
  });
});

describe('normalizeDistrictName', () => {
  it('collapses district suffix variants to the same key', () => {
    const a = normalizeDistrictName('Sample Independent School District');
    expect(normalizeDistrictName('Sample ISD')).toBe(a);
    expect(normalizeDistrictName('SAMPLE I.S.D.')).toBe(a);
  });

  it('keeps genuinely different districts apart', () => {
    expect(normalizeDistrictName('North Sample ISD')).not.toBe(
      normalizeDistrictName('South Sample ISD'),
    );
  });
});

describe('normalizeSchoolName', () => {
  it('collapses "Elementary" and "Elementary School"', () => {
    expect(normalizeSchoolName('Oak Ridge Elementary School')).toBe(
      normalizeSchoolName('Oak Ridge Elementary'),
    );
  });
});

describe('normalizeDepartmentName', () => {
  it.each([
    ['HR', 'Human Resources'],
    ['Human Resources', 'Human Resources'],
    ['IT', 'Technology'],
    ['SPED', 'Special Education'],
    ['Food Services', 'Child Nutrition'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeDepartmentName(input)).toBe(expected);
  });

  it('strips a trailing "Department" from an unmapped name', () => {
    expect(normalizeDepartmentName('Fine Arts Department')).toBe('Fine Arts');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['(555) 010-1001', '555-010-1001'],
    ['555.010.1002', '555-010-1002'],
    ['+1 555 010 1003', '555-010-1003'],
    ['15550101004', '555-010-1004'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('returns null for something that is not a ten digit number', () => {
    expect(normalizePhone('ext. 402')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('isShouting', () => {
  it('detects all-caps source values', () => {
    expect(isShouting('SMITH')).toBe(true);
    expect(isShouting('Smith')).toBe(false);
  });
});
