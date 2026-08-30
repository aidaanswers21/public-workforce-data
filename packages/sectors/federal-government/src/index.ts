import type { SectorPack } from '@pan/taxonomy';

/**
 * Federal government.
 *
 * The vertical that most tests the neutral model: a federal organization has a
 * federal jurisdiction and no state above it, while its people may have duty
 * locations in any number of states. Nothing in this pack asserts a state
 * parent, and nothing in the core requires one.
 */
export const federalGovernmentSectorPack: SectorPack = {
  key: 'federal_government',
  displayName: 'Federal government',
  description:
    'Federal departments, agencies, bureaus, field offices and independent establishments.',

  organizationTypes: [
    {
      code: 'federal_independent_agency',
      name: 'Federal independent agency',
      description: 'An independent establishment outside any cabinet department.',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      typicallySubordinate: false,
    },
    {
      code: 'federal_regional_office',
      name: 'Federal regional office',
      description:
        'A multi-state regional office of a federal body. Regional, not state-subordinate.',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      typicallySubordinate: true,
    },
    {
      code: 'federal_laboratory',
      name: 'Federal laboratory or centre',
      description: 'A federal research laboratory, centre or institute.',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      typicallySubordinate: true,
    },
  ],

  identifierSystems: [
    {
      code: 'federal_bureau_code',
      name: 'Federal bureau code',
      description: 'Treasury bureau code identifying a component within an agency.',
      appliesTo: 'organization',
      pattern: '^\\d{2}$',
      authority: 'U.S. Department of the Treasury',
    },
  ],

  roleCategories: [
    {
      code: 'agency_head',
      name: 'Agency head',
      description: 'Secretary, administrator, commissioner or director of a federal body.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'special_agent',
      name: 'Special agent',
      description: 'Federal criminal investigators and special agents.',
      jobFamilyCode: 'public_safety',
    },
    {
      code: 'contracting_officer',
      name: 'Contracting officer',
      description: 'Warranted contracting officers and specialists.',
      jobFamilyCode: 'finance',
    },
    {
      code: 'program_analyst',
      name: 'Program analyst',
      description: 'Federal program, management and budget analysts.',
      jobFamilyCode: 'research_policy',
    },
    {
      code: 'inspector_general',
      name: 'Inspector general',
      description: 'Office of inspector general staff.',
      jobFamilyCode: 'legal',
    },
    {
      code: 'foreign_service',
      name: 'Foreign service',
      description: 'Foreign service officers and specialists.',
      jobFamilyCode: 'leadership',
    },
  ],

  titleRules: [
    {
      test: /\b(secretary|deputy-secretary|under-secretary|assistant-secretary)\b/,
      roleCategoryCode: 'agency_head',
      seniorityCode: 'executive',
    },
    // Anchored on purpose. A bare "Administrator" is an agency head; "Zoning
    // Administrator" and "Database Administrator" are not, and an unanchored
    // rule here would shadow every one of them.
    {
      test: /^(administrator|commissioner|director-general)$/,
      roleCategoryCode: 'agency_head',
      seniorityCode: 'executive',
    },
    {
      test: /\b(deputy|acting|associate|assistant)-(administrator|commissioner)\b/,
      roleCategoryCode: 'agency_head',
      seniorityCode: 'executive',
    },
    {
      test: /\b(administrator|commissioner)-of-the?\b/,
      roleCategoryCode: 'agency_head',
      seniorityCode: 'executive',
    },
    {
      test: /\b(inspector-general|deputy-inspector-general)\b/,
      roleCategoryCode: 'inspector_general',
      seniorityCode: 'executive',
    },
    {
      test: /\bspecial-agent(-in-charge)?\b|\bcriminal-investigator\b/,
      roleCategoryCode: 'special_agent',
      seniorityCode: 'staff',
    },
    {
      test: /\b(contracting-officer|contract-specialist|procurement-analyst)\b/,
      roleCategoryCode: 'contracting_officer',
      seniorityCode: 'staff',
    },
    {
      test: /\b(program-analyst|management-analyst|budget-analyst|policy-analyst)\b/,
      roleCategoryCode: 'program_analyst',
      seniorityCode: 'staff',
    },
    {
      test: /\b(foreign-service-officer|consular-officer|attache)\b/,
      roleCategoryCode: 'foreign_service',
      seniorityCode: 'staff',
    },
  ],

  titleAbbreviations: [
    { pattern: /\bsac\b/gi, expansion: 'Special Agent in Charge' },
    { pattern: /\boig\b/gi, expansion: 'Office of Inspector General' },
    { pattern: /\bco\b\.?(?=\s|$)/gi, expansion: 'Contracting Officer' },
  ],

  vocabulary: {
    headingTerms: [
      'leadership',
      'agency leadership',
      'key personnel',
      'field offices',
      'regional offices',
      'bureau directory',
    ],
    urlHints: [
      { pattern: '/(leadership|our-leadership|agency-leadership)(/|$)', weight: 0.7 },
      { pattern: '/(field-offices?|regional-offices?|locations)(/|$)', weight: 0.6 },
      { pattern: '/(about/)?(staff|key-personnel|organization)(/|$)', weight: 0.7 },
    ],
    sharedInboxLocalParts: ['foia', 'oig', 'press', 'publicaffairs', 'ombudsman', 'congressional'],
    organizationLabelWords: [
      'bureau',
      'administration',
      'service',
      'directorate',
      'command',
      'laboratory',
    ],
    titleIndicatorTerms: [
      'secretary',
      'administrator',
      'agent',
      'attache',
      'inspector',
      'commissioner',
    ],
    organizationNameSuffixes: ['administration', 'bureau', 'service', 'directorate', 'office of'],
  },
};

export default federalGovernmentSectorPack;
