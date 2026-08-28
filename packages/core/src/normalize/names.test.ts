import { describe, expect, it } from 'vitest';
import { nameTokens, parsePersonName, personIdentityKey } from './names.js';

describe('parsePersonName', () => {
  it('splits a plain first and last name', () => {
    const parsed = parsePersonName('Jane Smith');
    expect(parsed.firstName).toBe('Jane');
    expect(parsed.lastName).toBe('Smith');
    expect(parsed.middleName).toBeNull();
    expect(parsed.lowConfidence).toBe(false);
  });

  it('handles the inverted "Last, First" form directories use', () => {
    const parsed = parsePersonName('Rivera, Ana M.');
    expect(parsed.firstName).toBe('Ana');
    expect(parsed.middleName).toBe('M.');
    expect(parsed.lastName).toBe('Rivera');
  });

  it('keeps the published name verbatim regardless of how it parses', () => {
    expect(parsePersonName('  Rivera,   Ana M. ').fullNamePublished).toBe('Rivera, Ana M.');
  });

  it('restores casing for shouting sources', () => {
    const parsed = parsePersonName('SMITH, ROBERT JR.');
    expect(parsed.firstName).toBe('Robert');
    expect(parsed.lastName).toBe('Smith');
    expect(parsed.suffix).toBe('Jr.');
  });

  it('separates a prefix from the given name', () => {
    const parsed = parsePersonName('Dr. Priya Raman');
    expect(parsed.prefix).toBe('Dr.');
    expect(parsed.firstName).toBe('Priya');
    expect(parsed.lastName).toBe('Raman');
  });

  it('treats post-nominal credentials after a comma as a suffix, not a first name', () => {
    const parsed = parsePersonName('Jane Smith, Ed.D.');
    expect(parsed.firstName).toBe('Jane');
    expect(parsed.lastName).toBe('Smith');
    expect(parsed.suffix).toBe('Ed.D.');
  });

  it('orders a generational suffix before a credential', () => {
    expect(parsePersonName('John Smith, Jr., Ph.D.').suffix).toBe('Jr., Ph.D.');
  });

  it('keeps surname particles with the surname', () => {
    const dutch = parsePersonName('Van Der Berg, Thomas');
    expect(dutch.firstName).toBe('Thomas');
    expect(dutch.lastName).toBe('Van Der Berg');

    const spanish = parsePersonName('Garcia, Maria de la Cruz');
    expect(spanish.firstName).toBe('Maria');
    expect(spanish.lastName).toBe('Garcia');
  });

  it('preserves internal capitals in Mc, O and hyphenated names', () => {
    expect(parsePersonName("O'BRIEN, KATHERINE").lastName).toBe("O'Brien");
    expect(parsePersonName('MCDONALD, ANGUS').lastName).toBe('McDonald');
    expect(parsePersonName('SMITH-JONES, ALICE').lastName).toBe('Smith-Jones');
  });

  it('flags a mononym as low confidence instead of inventing a first name', () => {
    const parsed = parsePersonName('Prince');
    expect(parsed.firstName).toBeNull();
    expect(parsed.lastName).toBe('Prince');
    expect(parsed.lowConfidence).toBe(true);
  });

  it('returns an empty parse for blank input', () => {
    const parsed = parsePersonName('   ');
    expect(parsed.firstName).toBeNull();
    expect(parsed.lastName).toBeNull();
    expect(parsed.lowConfidence).toBe(true);
  });

  it('strips accents when building match tokens but not the published name', () => {
    const parsed = parsePersonName('José García');
    expect(parsed.fullNamePublished).toBe('José García');
    expect(nameTokens(parsed)).toMatchObject({ first: 'jose', last: 'garcia' });
  });
});

describe('personIdentityKey', () => {
  it('ignores middle names so one person is not split into two', () => {
    const a = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'district-1',
      parsed: parsePersonName('Jane Smith'),
    });
    const b = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'district-1',
      parsed: parsePersonName('Jane M. Smith'),
    });
    expect(a).toBe(b);
  });

  it('keeps same-named people in different organizations distinct', () => {
    const a = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'district-1',
      parsed: parsePersonName('Jane Smith'),
    });
    const b = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'district-2',
      parsed: parsePersonName('Jane Smith'),
    });
    expect(a).not.toBe(b);
  });

  it('matches across the inverted and plain published forms', () => {
    const a = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'd',
      parsed: parsePersonName('Rivera, Ana M.'),
    });
    const b = personIdentityKey({
      stateCode: 'TX',
      orgScopeId: 'd',
      parsed: parsePersonName('Ana Rivera'),
    });
    expect(a).toBe(b);
  });
});
