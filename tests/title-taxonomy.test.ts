import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '@public-workforce/core';
import type { TitleRuleSet } from '@public-workforce/core';
import {
  EDUCATION_SCOPE,
  FEDERAL_SCOPE,
  NEUTRAL_SCOPE,
  STATE_LOCAL_SCOPE,
  allSectorsTaxonomy,
  titleRulesFor,
} from './support/taxonomy.js';

const TAXONOMY = allSectorsTaxonomy();

const BASE = titleRulesFor(TAXONOMY, NEUTRAL_SCOPE);
const EDUCATION = titleRulesFor(TAXONOMY, EDUCATION_SCOPE);
const FEDERAL = titleRulesFor(TAXONOMY, FEDERAL_SCOPE);
const LOCAL = titleRulesFor(TAXONOMY, STATE_LOCAL_SCOPE);
const PUBLIC_SAFETY = titleRulesFor(TAXONOMY, {
  sectorCode: 'public_safety',
  governmentLevelCode: 'municipal',
});
const PARKS = titleRulesFor(TAXONOMY, {
  sectorCode: 'parks_recreation',
  governmentLevelCode: 'municipal',
});
/** An education organization that a city runs, rather than an independent district. */
const MUNICIPAL_EDUCATION = titleRulesFor(TAXONOMY, {
  sectorCode: 'education',
  governmentLevelCode: 'municipal',
});

/**
 * The composed taxonomy, exercised across every shipped vertical.
 *
 * The neutral core's own tests cover how rules are applied. This file covers
 * what the shipped rules say and, above all, where they stop: a rule set is
 * built for one organization's sector and level, so a vertical's vocabulary
 * never reaches a record it has no business classifying.
 */
describe('composed title taxonomy', () => {
  it.each([
    // General government, at state and local levels
    ['City Manager', 'city_county_manager'],
    ['County Administrator', 'city_county_manager'],
    ['Mayor', 'elected_official'],
    ['City Council Member', 'elected_official'],
    ['City Clerk', 'records_clerk'],
    ['Zoning Administrator', 'planning_zoning'],
    ['Street Superintendent', 'public_works'],
    ['Elections Administrator', 'elections_official'],
    ['Clerk of the Court', 'court_staff'],
    ['Animal Control Officer', 'animal_services'],
    ['Code Enforcement Officer', 'code_enforcement'],
  ])('classifies %s as %s for a local government', (title, expected) => {
    expect(normalizeTitle(title, LOCAL).roleCategoryCode).toBe(expected);
  });

  it.each([
    // Neutral rules, which apply to every organization at every level
    ['Chief Financial Officer', 'department_head'],
    ['Deputy Director', 'deputy_executive'],
    ['Purchasing Agent', 'procurement'],
    ['Human Resources Generalist', 'human_resources'],
    ['GIS Analyst', 'data_analytics'],
    ['Public Information Officer', 'communications'],
    ['Budget Analyst', 'finance_accounting'],
    ['Building Inspector', 'inspector'],
    ['Water Treatment Operator', 'public_works'],
    ['Custodian', 'custodial'],
    ['Transit Operator', 'transportation_operations'],
    ['Librarian', 'library_services'],
    ['Executive Assistant', 'administrative_support'],
  ])('classifies %s as %s from the neutral base alone', (title, expected) => {
    expect(normalizeTitle(title, BASE).roleCategoryCode).toBe(expected);
  });

  it.each([
    ['Chief of Police', 'law_enforcement'],
    ['Police Sergeant', 'law_enforcement'],
    ['Deputy Sheriff', 'law_enforcement'],
    ['Fire Chief', 'fire_ems'],
    ['Firefighter Paramedic', 'fire_ems'],
    ['Emergency Management Coordinator', 'emergency_management'],
    ['911 Dispatcher', 'dispatch'],
    ['Probation Officer', 'corrections'],
  ])('classifies %s as %s for a public safety agency', (title, expected) => {
    expect(normalizeTitle(title, PUBLIC_SAFETY).roleCategoryCode).toBe(expected);
  });

  it.each([
    ['Deputy Secretary', 'agency_head'],
    ['Special Agent in Charge', 'special_agent'],
    ['Contracting Officer', 'contracting_officer'],
    ['Inspector General', 'inspector_general'],
    ['Foreign Service Officer', 'foreign_service'],
  ])('classifies %s as %s for a federal body', (title, expected) => {
    expect(normalizeTitle(title, FEDERAL).roleCategoryCode).toBe(expected);
  });

  it.each([
    ['Superintendent of Schools', 'district_superintendent'],
    ['Assistant Superintendent', 'district_leadership'],
    ['Principal', 'school_principal'],
    ['Assistant Principal', 'assistant_principal'],
    ['4th Grade Teacher', 'teacher'],
    ['School Counselor', 'school_counselor'],
    ['Special Education Diagnostician', 'special_education'],
    ['Paraprofessional', 'paraprofessional'],
    ['Athletic Director', 'coach_athletics'],
    ['Band Director', 'fine_arts'],
    ['School Nurse', 'school_nurse'],
  ])('classifies %s as %s for an education organization', (title, expected) => {
    expect(normalizeTitle(title, EDUCATION).roleCategoryCode).toBe(expected);
  });

  it('resolves a job family for every role it assigns', () => {
    const families = new Set(TAXONOMY.jobFamilies.map((row) => row.code));
    for (const role of TAXONOMY.roleCategories) {
      expect(families, `role ${role.code} names an unknown family`).toContain(role.jobFamilyCode);
    }
  });

  it('covers support roles, not only decision makers', () => {
    for (const role of ['Custodian', 'Bus Driver', 'Cafeteria Worker', 'Groundskeeper']) {
      expect(normalizeTitle(role, EDUCATION).roleCategoryCode, role).not.toBe('unknown');
    }
    expect(normalizeTitle('Records Clerk', BASE).roleCategoryCode).toBe('records_clerk');
  });

  it('records which vertical produced the match', () => {
    expect(normalizeTitle('Principal', EDUCATION).ruleSource).toBe('education');
    expect(normalizeTitle('City Manager', LOCAL).ruleSource).toBe('state_local_government');
    expect(normalizeTitle('Special Agent', FEDERAL).ruleSource).toBe('federal_government');
    expect(normalizeTitle('Building Inspector', BASE).ruleSource).toBe('base');
  });

  it('extracts specialties within the scope that defines them', () => {
    expect(normalizeTitle('Traffic Engineer', LOCAL).specialty).toBe('Traffic');
    expect(normalizeTitle('Math Teacher', EDUCATION).specialty).toBe('Math');
    expect(normalizeTitle('Narcotics Detective', PUBLIC_SAFETY).specialty).toBe('Narcotics');
  });

  it('gives an unmatched title the fallback rather than dropping it', () => {
    const result = normalizeTitle('Chief Wombat Wrangler', LOCAL);
    expect(result.titlePublished).toBe('Chief Wombat Wrangler');
    expect(result.roleCategoryCode).not.toBe('unknown');
  });

  it('produces a stable version that changes when the rules change', () => {
    const before = titleRulesFor(TAXONOMY, EDUCATION_SCOPE).version;
    expect(before).toBe(titleRulesFor(allSectorsTaxonomy(), EDUCATION_SCOPE).version);
    expect(before).not.toBe(
      titleRulesFor(
        allSectorsTaxonomy([
          {
            key: 'extra',
            displayName: 'Extra',
            description: 'adds one rule',
            appliesTo: { sectorCodes: null, governmentLevelCodes: null },
            titleRules: [
              { test: /\bextra-role\b/, roleCategoryCode: 'other', seniorityCode: 'staff' },
            ],
          },
        ]),
        EDUCATION_SCOPE,
      ).version,
    );
  });

  it('records the same version whichever scope applied', () => {
    // Two records normalized under one taxonomy must compare equal even when
    // different packs read them, so the version describes the taxonomy rather
    // than the subset that happened to match.
    expect(titleRulesFor(TAXONOMY, EDUCATION_SCOPE).version).toBe(
      titleRulesFor(TAXONOMY, FEDERAL_SCOPE).version,
    );
  });
});

/**
 * The nine titles that prove the seam.
 *
 * Each is a word one vertical owns and another vertical uses differently. Every
 * one of them was classified wrongly before rules were scoped, or before the
 * over-broad rule behind it was narrowed.
 */
describe('a vertical cannot classify another vertical’s people', () => {
  const scopes: readonly [string, TitleRuleSet][] = [
    ['neutral base', BASE],
    ['education', EDUCATION],
    ['federal', FEDERAL],
    ['county', LOCAL],
    ['parks and recreation', PARKS],
    ['public safety', PUBLIC_SAFETY],
  ];

  function inEvery(title: string, assertion: (code: string, scopeName: string) => void): void {
    for (const [name, rules] of scopes)
      assertion(normalizeTitle(title, rules).roleCategoryCode, name);
  }

  it('Veterans Counselor is never a school counsellor', () => {
    // A county veterans office employs one. A bare `counselor` rule in the
    // education pack used to claim it even at a county.
    inEvery('Veterans Counselor', (code, scope) => {
      expect(code, `scope ${scope}`).not.toBe('school_counselor');
    });
  });

  it('Fitness Instructor is never a teacher', () => {
    // Parks departments and school districts both employ one, and neither is
    // teaching a class.
    inEvery('Fitness Instructor', (code, scope) => {
      expect(code, `scope ${scope}`).not.toBe('teacher');
    });
  });

  it('Principal Architect is never a school principal', () => {
    inEvery('Principal Architect', (code, scope) => {
      expect(code, `scope ${scope}`).not.toBe('school_principal');
    });
    // At a local government it reads as the senior technical role it is.
    expect(normalizeTitle('Principal Architect', LOCAL).roleCategoryCode).toBe('analyst');
  });

  it('Principal Scientist is never a school principal', () => {
    inEvery('Principal Scientist', (code, scope) => {
      expect(code, `scope ${scope}`).not.toBe('school_principal');
    });
  });

  it('Executive Assistant is administrative support everywhere, never an executive', () => {
    inEvery('Executive Assistant', (code, scope) => {
      expect(code, `scope ${scope}`).toBe('administrative_support');
    });
    expect(normalizeTitle('Executive Assistant', LOCAL).seniorityCode).not.toBe('executive');
  });

  it('Deputy Chief is a deputy executive in every scope', () => {
    // A neutral title, so every scope must agree. If a vertical ever claims it,
    // that vertical has taken a word it does not own.
    inEvery('Deputy Chief', (code, scope) => {
      expect(code, `scope ${scope}`).toBe('deputy_executive');
    });
  });

  it('School Counselor is a school counsellor only in education', () => {
    expect(normalizeTitle('School Counselor', EDUCATION).roleCategoryCode).toBe('school_counselor');
    for (const [name, rules] of scopes) {
      if (name === 'education') continue;
      expect(normalizeTitle('School Counselor', rules).roleCategoryCode, name).not.toBe(
        'school_counselor',
      );
    }
  });

  it('Teacher is a teacher only in education', () => {
    expect(normalizeTitle('Teacher', EDUCATION).roleCategoryCode).toBe('teacher');
    for (const [name, rules] of scopes) {
      if (name === 'education') continue;
      expect(normalizeTitle('Teacher', rules).roleCategoryCode, name).not.toBe('teacher');
    }
  });

  it('Contracting Officer is a federal contracting officer only at the federal level', () => {
    expect(normalizeTitle('Contracting Officer', FEDERAL).roleCategoryCode).toBe(
      'contracting_officer',
    );
    for (const [name, rules] of scopes) {
      if (name === 'federal') continue;
      // Elsewhere it is ordinary procurement, from the neutral base.
      expect(normalizeTitle('Contracting Officer', rules).roleCategoryCode, name).toBe(
        'procurement',
      );
    }
  });

  it('federal abbreviations do not expand outside the federal level', () => {
    const federal = normalizeTitle('Special Agent', FEDERAL);
    expect(federal.ruleSource).toBe('federal_government');
    for (const [name, rules] of scopes) {
      if (name === 'federal') continue;
      expect(normalizeTitle('Special Agent', rules).ruleSource, name).not.toBe(
        'federal_government',
      );
    }
  });

  it('follows the sector, not the level, for education', () => {
    // The whole point of C9: a city-run school is municipal and still
    // education-sector, so education rules must reach it, and the state and
    // local rules must not.
    expect(normalizeTitle('Principal', MUNICIPAL_EDUCATION).roleCategoryCode).toBe(
      'school_principal',
    );
    expect(normalizeTitle('City Manager', MUNICIPAL_EDUCATION).ruleSource).not.toBe(
      'state_local_government',
    );
  });

  it('applies the neutral base in every scope, including an unclassified one', () => {
    for (const [name, rules] of scopes) {
      expect(normalizeTitle('Building Inspector', rules).roleCategoryCode, name).toBe('inspector');
    }
  });

  it('precedence is scope, then registration order, then the base', () => {
    const scoped = TAXONOMY.forScope(EDUCATION_SCOPE);
    expect(scoped.packKeys).toEqual(['education']);
    expect(TAXONOMY.forScope(FEDERAL_SCOPE).packKeys).toEqual(['federal_government']);
    expect(TAXONOMY.forScope(STATE_LOCAL_SCOPE).packKeys).toEqual(['state_local_government']);
    expect(TAXONOMY.forScope(NEUTRAL_SCOPE).packKeys).toEqual([]);
    // Within a scope, the matching pack's rules are tried before the base.
    const educationIndex = scoped.titleRules.findIndex((rule) => rule.source === 'education');
    const baseIndex = scoped.titleRules.findIndex((rule) => rule.source === 'base');
    expect(educationIndex).toBeLessThan(baseIndex);
  });
});
