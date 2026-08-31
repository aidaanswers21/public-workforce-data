import type { SectorPack } from '@public-workforce/taxonomy';

/**
 * State, county, municipal and special-district government.
 *
 * Most of what this vertical needs is already neutral, because general
 * government is what the base taxonomy was written from. What it adds is the
 * elected and statutory offices that only exist at these levels.
 */
export const stateLocalGovernmentSectorPack: SectorPack = {
  key: 'state_local_government',
  displayName: 'State and local government',
  description:
    'State agencies, counties, municipalities, townships, special districts and public authorities.',

  /**
   * General-purpose government below the federal level.
   *
   * Both dimensions are listed rather than left as wildcards, and the education
   * sector is deliberately absent. Education organizations sit at these very
   * levels now that `education` is a sector rather than a level, so scoping by
   * level alone would let a county rule classify a school employee. Naming the
   * sectors keeps the two apart while still covering the whole of general
   * government.
   */
  appliesTo: {
    sectorCodes: [
      'general_government',
      'public_safety',
      'health_human_services',
      'transportation',
      'utilities',
      'environment',
      'finance_revenue',
      'judicial',
      'legislative',
      'workforce_labor',
      'housing_community',
      'parks_recreation',
      'library_culture',
      'elections',
      'other',
    ],
    governmentLevelCodes: [
      'state',
      'county',
      'municipal',
      'township',
      'special_district',
      'tribal',
      'other_public_authority',
    ],
  },

  organizationTypes: [
    {
      code: 'state_board_commission',
      name: 'State board or commission',
      description: 'A state licensing board, regulatory commission or advisory body.',
      defaultGovernmentLevelCode: 'state',
      defaultSectorCode: 'general_government',
      typicallySubordinate: false,
    },
    {
      code: 'county_elected_office',
      name: 'County elected office',
      description:
        'A separately elected county office such as sheriff, clerk, assessor or treasurer.',
      defaultGovernmentLevelCode: 'county',
      defaultSectorCode: 'general_government',
      typicallySubordinate: true,
    },
    {
      code: 'municipal_utility',
      name: 'Municipal utility',
      description: 'A utility operated by a municipality.',
      defaultGovernmentLevelCode: 'municipal',
      defaultSectorCode: 'utilities',
      typicallySubordinate: true,
    },
    {
      code: 'court',
      name: 'Court',
      description: 'A court or court administration office at any level.',
      defaultGovernmentLevelCode: 'other_public_authority',
      defaultSectorCode: 'judicial',
      typicallySubordinate: false,
    },
  ],

  roleCategories: [
    {
      code: 'city_county_manager',
      name: 'City or county manager',
      description: 'Appointed chief administrative officer of a locality.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'code_enforcement',
      name: 'Code enforcement',
      description: 'Code compliance and nuisance abatement officers.',
      jobFamilyCode: 'engineering_technical',
    },
    {
      code: 'animal_services',
      name: 'Animal services',
      description: 'Animal control and shelter staff.',
      jobFamilyCode: 'field_services',
    },
    {
      code: 'court_staff',
      name: 'Court staff',
      description: 'Judges, clerks of court and judicial administration staff.',
      jobFamilyCode: 'legal',
    },
  ],

  titleRules: [
    {
      test: /\b(city|county|town|village)-manager\b/,
      roleCategoryCode: 'city_county_manager',
      seniorityCode: 'executive',
    },
    {
      test: /\b(county|city)-administrator\b/,
      roleCategoryCode: 'city_county_manager',
      seniorityCode: 'executive',
    },
    {
      test: /\b(code-(enforcement|compliance)|nuisance-abatement)\b/,
      roleCategoryCode: 'code_enforcement',
      seniorityCode: 'staff',
    },
    {
      test: /\b(animal-(control|services|shelter))\b/,
      roleCategoryCode: 'animal_services',
      seniorityCode: 'staff',
    },
    {
      test: /\b(judge|magistrate|justice-of-the-peace|clerk-of-(the-)?court|court-(clerk|administrator|reporter))\b/,
      roleCategoryCode: 'court_staff',
      seniorityCode: 'staff',
    },
    {
      test: /\b(county-(commissioner|judge|executive)|board-of-supervisors)\b/,
      roleCategoryCode: 'elected_official',
      seniorityCode: 'executive',
    },
    {
      test: /\b(public-works|street|water|sewer|sanitation|parks|building)-superintendent\b/,
      roleCategoryCode: 'public_works',
      seniorityCode: 'director',
    },
    {
      test: /\bsuperintendent-of-(public-works|streets|water|parks|buildings)\b/,
      roleCategoryCode: 'public_works',
      seniorityCode: 'director',
    },
    // "Principal" as a senior individual contributor, not as a head of school.
    {
      test: /\bprincipal-(engineer|planner|analyst|investigator|architect|scientist)\b/,
      roleCategoryCode: 'analyst',
      seniorityCode: 'lead',
    },
  ],

  vocabulary: {
    headingTerms: [
      'elected officials',
      'county officials',
      'city officials',
      'department directory',
      'city council',
      'board of supervisors',
      'county commissioners',
      'staff directory',
    ],
    urlHints: [
      { pattern: '/(elected-officials|county-officials|city-officials)(/|$)', weight: 0.85 },
      { pattern: '/(city-council|board-of-supervisors|commissioners-court)(/|$)', weight: 0.6 },
      { pattern: '/government/(departments?|staff|directory)(/|$)', weight: 0.8 },
    ],
    sharedInboxLocalParts: [
      'cityclerk',
      'countyclerk',
      'citymanager',
      'countymanager',
      'codeenforcement',
      'animalcontrol',
      'courts',
    ],
    organizationLabelWords: [
      'township',
      'borough',
      'village',
      'municipality',
      'county',
      'city',
      'court',
    ],
    titleIndicatorTerms: [
      'councilmember',
      'alderman',
      'selectman',
      'judge',
      'magistrate',
      'constable',
      'trustee',
      'superintendent',
    ],
    organizationNameSuffixes: [
      'board of supervisors',
      'commissioners court',
      'city council',
      'town council',
    ],
  },
};

export default stateLocalGovernmentSectorPack;
