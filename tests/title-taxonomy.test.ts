import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '@pan/core';
import { allSectorsTaxonomy, titleRulesFor } from './support/taxonomy.js';

const TAXONOMY = allSectorsTaxonomy();
const RULES = titleRulesFor(TAXONOMY);

/**
 * The composed taxonomy, exercised across every shipped vertical.
 *
 * The neutral core's own tests cover how rules are applied. This file covers
 * what the shipped rules say, which is the part that changes when a sector
 * package grows.
 */
describe('composed title taxonomy', () => {
  it.each([
    // General government
    ['City Manager', 'city_county_manager'],
    ['County Administrator', 'city_county_manager'],
    ['Mayor', 'elected_official'],
    ['City Council Member', 'elected_official'],
    ['Chief Financial Officer', 'department_head'],
    ['Deputy Director', 'deputy_executive'],
    ['City Clerk', 'records_clerk'],
    ['Budget Analyst', 'program_analyst'],
    ['Purchasing Agent', 'procurement'],
    ['Human Resources Generalist', 'human_resources'],
    ['GIS Analyst', 'data_analytics'],
    ['Public Information Officer', 'communications'],
    ['Building Inspector', 'inspector'],
    ['Zoning Administrator', 'planning_zoning'],
    ['Water Treatment Operator', 'public_works'],
    ['Street Superintendent', 'public_works'],
    ['Custodian', 'custodial'],
    ['Transit Operator', 'transportation_operations'],
    ['Librarian', 'library_services'],
    ['Elections Administrator', 'elections_official'],
    ['Animal Control Officer', 'animal_services'],
    ['Code Enforcement Officer', 'code_enforcement'],
    ['Clerk of the Court', 'court_staff'],

    // Public safety
    ['Chief of Police', 'law_enforcement'],
    ['Police Sergeant', 'law_enforcement'],
    ['Deputy Sheriff', 'law_enforcement'],
    ['Fire Chief', 'fire_ems'],
    ['Firefighter Paramedic', 'fire_ems'],
    ['Emergency Management Coordinator', 'emergency_management'],
    ['911 Dispatcher', 'dispatch'],
    ['Probation Officer', 'corrections'],

    // Federal
    ['Deputy Secretary', 'agency_head'],
    ['Special Agent in Charge', 'special_agent'],
    ['Contracting Officer', 'contracting_officer'],
    ['Inspector General', 'inspector_general'],
    ['Foreign Service Officer', 'foreign_service'],

    // Education
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
  ])('classifies %s as %s', (title, expected) => {
    expect(normalizeTitle(title, RULES).roleCategoryCode).toBe(expected);
  });

  it('resolves a job family for every role it assigns', () => {
    const families = new Set(TAXONOMY.jobFamilies.map((row) => row.code));
    for (const role of TAXONOMY.roleCategories) {
      expect(families, `role ${role.code} names an unknown family`).toContain(role.jobFamilyCode);
    }
  });

  it('keeps the two dual-use words apart by context', () => {
    // "Superintendent" and "Principal" mean different things in different verticals.
    expect(normalizeTitle('Superintendent of Schools', RULES).roleCategoryCode).toBe(
      'district_superintendent',
    );
    expect(normalizeTitle('Water Superintendent', RULES).roleCategoryCode).toBe('public_works');
    expect(normalizeTitle('Principal', RULES).roleCategoryCode).toBe('school_principal');
    expect(normalizeTitle('Principal Engineer', RULES).roleCategoryCode).toBe('analyst');
  });

  it('covers support roles, not only decision makers', () => {
    for (const role of [
      'Custodian',
      'Bus Driver',
      'Cafeteria Worker',
      'Groundskeeper',
      'Records Clerk',
    ]) {
      expect(normalizeTitle(role, RULES).roleCategoryCode, role).not.toBe('unknown');
    }
  });

  it('records which vertical produced the match', () => {
    expect(normalizeTitle('Principal', RULES).ruleSource).toBe('education');
    expect(normalizeTitle('City Manager', RULES).ruleSource).toBe('state_local_government');
    expect(normalizeTitle('Special Agent', RULES).ruleSource).toBe('federal_government');
    expect(normalizeTitle('Building Inspector', RULES).ruleSource).toBe('base');
  });

  it('extracts specialties from any vertical', () => {
    expect(normalizeTitle('Traffic Engineer', RULES).specialty).toBe('Traffic');
    expect(normalizeTitle('Math Teacher', RULES).specialty).toBe('Math');
    expect(normalizeTitle('Narcotics Detective', RULES).specialty).toBe('Narcotics');
  });

  it('gives an unmatched title the fallback rather than dropping it', () => {
    const result = normalizeTitle('Chief Wombat Wrangler', RULES);
    expect(result.titlePublished).toBe('Chief Wombat Wrangler');
    expect(result.roleCategoryCode).not.toBe('unknown');
  });

  it('produces a stable version that changes when the rules change', () => {
    const before = titleRulesFor(TAXONOMY).version;
    expect(before).toBe(titleRulesFor(allSectorsTaxonomy()).version);
    expect(before).not.toBe(
      titleRulesFor(
        allSectorsTaxonomy([
          {
            key: 'extra',
            displayName: 'Extra',
            description: 'adds one rule',
            titleRules: [
              { test: /\bextra-role\b/, roleCategoryCode: 'other', seniorityCode: 'staff' },
            ],
          },
        ]),
      ).version,
    );
  });
});
