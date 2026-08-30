import { describe, expect, it } from 'vitest';
import {
  collapseDottedAcronyms,
  collapseWhitespace,
  isShouting,
  normalizeCountyName,
  normalizeKey,
  normalizeOrganizationName,
  normalizePhone,
  normalizeUnitName,
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

describe('normalizeOrganizationName', () => {
  const suffixes = ['department', 'bureau of', 'office of', 'board of supervisors', 'agency'];

  it('drops the supplied suffixes and folds case', () => {
    expect(normalizeOrganizationName('Public Works Department', suffixes)).toBe('public-works');
    expect(normalizeOrganizationName('Bureau of Reclamation', suffixes)).toBe('reclamation');
  });

  it('prefers a longer suffix over a substring of it', () => {
    expect(normalizeOrganizationName('Marin Board of Supervisors', suffixes)).toBe('marin');
  });

  it('collapses dotted acronyms so both spellings match', () => {
    expect(normalizeOrganizationName('U.S.D.A. Forest Service')).toBe(
      normalizeOrganizationName('USDA Forest Service'),
    );
  });

  it('carries no vertical-specific knowledge of its own', () => {
    // With no suffixes supplied it must not silently strip anything.
    expect(normalizeOrganizationName('Sample Special District')).toBe('sample-special-district');
  });

  it('keeps genuinely different organizations apart', () => {
    expect(normalizeOrganizationName('North County Fire District', suffixes)).not.toBe(
      normalizeOrganizationName('South County Fire District', suffixes),
    );
  });
});

describe('collapseDottedAcronyms', () => {
  it('collapses runs of single letters followed by periods', () => {
    expect(collapseDottedAcronyms('F.B.I. field office')).toBe('FBI field office');
  });

  it('leaves ordinary sentences alone', () => {
    expect(collapseDottedAcronyms('Public works. Streets division.')).toBe(
      'Public works. Streets division.',
    );
  });
});

describe('normalizeUnitName', () => {
  it.each([
    ['HR', 'Human Resources'],
    ['IT', 'Information Technology'],
    ['DPW', 'Public Works'],
    ['OIG', 'Office of Inspector General'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeUnitName(input)).toBe(expected);
  });

  it('strips a trailing organizational word from an unmapped name', () => {
    expect(normalizeUnitName('Code Enforcement Division')).toBe('Code Enforcement');
  });

  it('accepts caller-supplied aliases', () => {
    expect(normalizeUnitName('SPED', new Map([['sped', 'Special Education']]))).toBe(
      'Special Education',
    );
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
