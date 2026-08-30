/**
 * Title normalization is rule-driven and composable.
 *
 * The neutral base below knows only what is true of public employment in
 * general. Everything a particular vertical knows about its own titles lives in
 * that vertical's sector package and is layered on at composition time, which is
 * why the crawler core can read a published title without knowing what kind of
 * public body published it.
 */
export interface TitleRule {
  /** Matched against the hyphen-normalized title key. */
  test: RegExp;
  roleCategoryCode: string;
  seniorityCode: string;
  /** 0..1 confidence in this assignment. Broader rules score lower. */
  confidence?: number;
  /** Which pack contributed the rule, recorded on the normalization for audit. */
  source?: string;
}

export interface TitleAbbreviation {
  pattern: RegExp;
  expansion: string;
}

export const SENIORITY_LEVELS: readonly { code: string; name: string; description: string }[] = [
  {
    code: 'executive',
    name: 'Executive',
    description: 'Agency head, elected official or equivalent.',
  },
  {
    code: 'director',
    name: 'Director',
    description: 'Directs a department, division or major program.',
  },
  { code: 'manager', name: 'Manager', description: 'Manages a unit, program or team.' },
  { code: 'supervisor', name: 'Supervisor', description: 'First-line supervision of staff.' },
  { code: 'lead', name: 'Lead', description: 'Leads work without formal supervisory authority.' },
  { code: 'senior', name: 'Senior', description: 'Experienced individual contributor.' },
  { code: 'staff', name: 'Staff', description: 'Individual contributor.' },
  { code: 'support', name: 'Support', description: 'Support, aide or assistant role.' },
  { code: 'unknown', name: 'Unknown', description: 'Not determined from the published title.' },
];

export const SENIORITY_CODES = SENIORITY_LEVELS.map((row) => row.code);

/**
 * Abbreviations that mean the same thing across every level of government.
 * Each pattern consumes its own trailing period so "Asst." expands cleanly.
 */
export const BASE_TITLE_ABBREVIATIONS: readonly TitleAbbreviation[] = [
  { pattern: /\basst\b\.?/gi, expansion: 'Assistant' },
  { pattern: /\bassoc\b\.?/gi, expansion: 'Associate' },
  { pattern: /\bdep\b\.?/gi, expansion: 'Deputy' },
  { pattern: /\bdir\b\.?/gi, expansion: 'Director' },
  { pattern: /\bcoord\b\.?/gi, expansion: 'Coordinator' },
  { pattern: /\bmgr\b\.?/gi, expansion: 'Manager' },
  { pattern: /\bsupv\b\.?/gi, expansion: 'Supervisor' },
  { pattern: /\bspec\b\.?/gi, expansion: 'Specialist' },
  { pattern: /\btech\b\.?/gi, expansion: 'Technician' },
  { pattern: /\badmin\b\.?/gi, expansion: 'Administrative' },
  { pattern: /\bhr\b/gi, expansion: 'Human Resources' },
  { pattern: /\bit\b/gi, expansion: 'Information Technology' },
  { pattern: /\bpio\b/gi, expansion: 'Public Information Officer' },
  { pattern: /\bcfo\b/gi, expansion: 'Chief Financial Officer' },
  { pattern: /\bcio\b/gi, expansion: 'Chief Information Officer' },
  { pattern: /\bcto\b/gi, expansion: 'Chief Technology Officer' },
  { pattern: /\bcoo\b/gi, expansion: 'Chief Operating Officer' },
  { pattern: /\bems\b/gi, expansion: 'Emergency Medical Services' },
  { pattern: /\bpw\b/gi, expansion: 'Public Works' },
];

/**
 * Ordered most specific first. First match wins, so a rule that could be
 * shadowed by a broader one must appear above it.
 */
export const BASE_TITLE_RULES: readonly TitleRule[] = [
  {
    test: /\b(city|county|town|village|township|borough)-(manager|administrator)\b/,
    roleCategoryCode: 'chief_executive',
    seniorityCode: 'executive',
  },
  {
    test: /\b(chief-(executive|administrative)-officer|executive-director)\b/,
    roleCategoryCode: 'chief_executive',
    seniorityCode: 'executive',
  },
  {
    test: /\b(governor|lieutenant-governor|mayor|vice-mayor|deputy-mayor)\b/,
    roleCategoryCode: 'elected_official',
    seniorityCode: 'executive',
  },
  {
    test: /\b(council-?(member|man|woman)|alder(man|woman|person)|selectman|selectperson|freeholder|state-(senator|representative)|assembly-?member)\b/,
    roleCategoryCode: 'elected_official',
    seniorityCode: 'executive',
  },
  {
    test: /\b(board-(member|chair|chairman|chairwoman|president|vice-president|secretary|treasurer)|commission(er)?-member|trustee)\b/,
    roleCategoryCode: 'board_member',
    seniorityCode: 'executive',
  },

  {
    test: /\b(chief-of-police|police-chief|sheriff|undersheriff|marshal)\b/,
    roleCategoryCode: 'law_enforcement',
    seniorityCode: 'executive',
  },
  {
    test: /\b(fire-chief|chief-of-(the-)?fire|battalion-chief|fire-marshal)\b/,
    roleCategoryCode: 'fire_ems',
    seniorityCode: 'executive',
  },
  {
    test: /\b(police-officer|deputy-sheriff|detective|investigator|patrol|corporal|sergeant|lieutenant|captain|constable|trooper)\b/,
    roleCategoryCode: 'law_enforcement',
    seniorityCode: 'staff',
  },
  {
    test: /\b(firefighter|fire-fighter|paramedic|emergency-medical|emt|engineer-fire)\b/,
    roleCategoryCode: 'fire_ems',
    seniorityCode: 'staff',
  },
  {
    test: /\b(emergency-(management|preparedness)|homeland-security)\b/,
    roleCategoryCode: 'emergency_management',
    seniorityCode: 'staff',
  },
  {
    test: /\b(dispatcher|telecommunicator|911|nine-one-one)\b/,
    roleCategoryCode: 'dispatch',
    seniorityCode: 'staff',
  },
  {
    test: /\b(corrections?|detention|jailer|probation|parole)\b/,
    roleCategoryCode: 'corrections',
    seniorityCode: 'staff',
  },

  {
    test: /\b(chief-(financial|information|technology|operating|data|security|innovation|human-resources)-officer)\b/,
    roleCategoryCode: 'department_head',
    seniorityCode: 'executive',
  },
  {
    test: /\b(deputy|assistant|associate)-(director|administrator|chief|manager|commissioner|secretary)\b/,
    roleCategoryCode: 'deputy_executive',
    seniorityCode: 'director',
  },

  {
    test: /\b(city|county|state)-(attorney|counsel|solicitor)\b/,
    roleCategoryCode: 'legal_counsel',
    seniorityCode: 'director',
  },
  {
    test: /\b(attorney|counsel|paralegal|legal-(assistant|analyst)|compliance-officer)\b/,
    roleCategoryCode: 'legal_counsel',
    seniorityCode: 'staff',
  },

  {
    test: /\b(city|county|town|village|municipal)-clerk\b/,
    roleCategoryCode: 'records_clerk',
    seniorityCode: 'director',
  },
  {
    test: /\b(registrar|recorder|licens(e|ing)|permit-(technician|clerk)|records-(clerk|manager|specialist)|vital-records)\b/,
    roleCategoryCode: 'records_clerk',
    seniorityCode: 'staff',
  },
  {
    test: /\b(elections?-(administrator|official|clerk|coordinator)|voter-registration)\b/,
    roleCategoryCode: 'elections_official',
    seniorityCode: 'staff',
  },

  {
    test: /\b(treasurer|comptroller|controller|budget-(director|officer|analyst|manager)|revenue-(officer|manager))\b/,
    roleCategoryCode: 'finance_accounting',
    seniorityCode: 'director',
  },
  {
    test: /\b(accountant|accounting|payroll|bookkeeper|billing|accounts-(payable|receivable)|fiscal)\b/,
    roleCategoryCode: 'finance_accounting',
    seniorityCode: 'staff',
  },
  {
    test: /\b(assessor|appraiser|tax-(collector|assessor))\b/,
    roleCategoryCode: 'finance_accounting',
    seniorityCode: 'staff',
  },
  { test: /\b(auditor|internal-audit)\b/, roleCategoryCode: 'auditor', seniorityCode: 'staff' },
  {
    test: /\b(purchasing|procurement|contract(ing|s)-(officer|manager|specialist)|buyer)\b/,
    roleCategoryCode: 'procurement',
    seniorityCode: 'staff',
  },

  {
    test: /\b(human-resources|personnel|talent|benefits|classification|labor-relations|recruit(er|ment))\b/,
    roleCategoryCode: 'human_resources',
    seniorityCode: 'staff',
  },
  {
    test: /\b(information-technology|systems-(administrator|analyst|engineer)|network|help-?desk|desktop-support|cyber(security)?|applications?-(developer|analyst)|programmer|software)\b/,
    roleCategoryCode: 'information_technology',
    seniorityCode: 'staff',
  },
  {
    test: /\b(data-(analyst|scientist|engineer|manager)|business-intelligence|gis|geographic-information)\b/,
    roleCategoryCode: 'data_analytics',
    seniorityCode: 'staff',
  },
  {
    test: /\b(public-information|communications?|media-relations|press-secretary|public-relations|webmaster|social-media|marketing)\b/,
    roleCategoryCode: 'communications',
    seniorityCode: 'staff',
  },

  {
    test: /\b(public-health|epidemiolog(y|ist)|health-(inspector|educator|officer)|sanitarian|nurse|clinician|physician)\b/,
    roleCategoryCode: 'public_health',
    seniorityCode: 'staff',
  },
  {
    test: /\b(social-worker|case-(worker|manager)|eligibility|benefits-(specialist|worker)|child-(welfare|protective)|family-services)\b/,
    roleCategoryCode: 'social_services',
    seniorityCode: 'staff',
  },

  {
    test: /\b(city|county|state)-engineer\b/,
    roleCategoryCode: 'engineering',
    seniorityCode: 'director',
  },
  {
    test: /\b(engineer|engineering|surveyor|drafter|cad-technician)\b/,
    roleCategoryCode: 'engineering',
    seniorityCode: 'staff',
  },
  {
    test: /\b(inspector|inspections?|code-enforcement|building-official)\b/,
    roleCategoryCode: 'inspector',
    seniorityCode: 'staff',
  },
  {
    test: /\b(planner|planning|zoning|development-review|economic-development|community-development)\b/,
    roleCategoryCode: 'planning_zoning',
    seniorityCode: 'staff',
  },

  {
    test: /\b(public-works|streets?|water-(operator|treatment|distribution)|wastewater|sewer|sanitation|utilit(y|ies)-(operator|worker)|solid-waste)\b/,
    roleCategoryCode: 'public_works',
    seniorityCode: 'staff',
  },
  {
    test: /\b(facilit(y|ies)|maintenance|building-(maintenance|services)|hvac|electrician|plumber|carpenter|mechanic|trades)\b/,
    roleCategoryCode: 'facilities_maintenance',
    seniorityCode: 'staff',
  },
  {
    test: /\b(custodian|custodial|janitor|groundskeeper|grounds-maintenance)\b/,
    roleCategoryCode: 'custodial',
    seniorityCode: 'support',
  },
  {
    test: /\b(driver|transit-operator|bus-(operator|monitor)|fleet|motor-pool|transportation-(operator|dispatcher))\b/,
    roleCategoryCode: 'transportation_operations',
    seniorityCode: 'support',
  },
  {
    test: /\b(food-service|nutrition|cafeteria|kitchen|cook|dietar(y|ian))\b/,
    roleCategoryCode: 'food_services',
    seniorityCode: 'support',
  },

  {
    test: /\b(parks?|recreation|athletics-(coordinator|supervisor)|aquatics|community-center)\b/,
    roleCategoryCode: 'parks_recreation',
    seniorityCode: 'staff',
  },
  { test: /\b(librarian|library)\b/, roleCategoryCode: 'library_services', seniorityCode: 'staff' },

  {
    test: /\b(program-(manager|director|administrator)|project-(manager|director))\b/,
    roleCategoryCode: 'program_manager',
    seniorityCode: 'manager',
  },
  {
    test: /\b(analyst|research(er)?|evaluat(or|ion)|policy-(analyst|advisor))\b/,
    roleCategoryCode: 'analyst',
    seniorityCode: 'staff',
  },
  {
    test: /\b(volunteer|community-liaison|outreach-(worker|coordinator)|ombuds(man|person))\b/,
    roleCategoryCode: 'volunteer_community',
    seniorityCode: 'support',
  },

  {
    test: /\b(administrative-(assistant|specialist|coordinator|aide)|secretary|receptionist|office-(manager|assistant|specialist)|clerk|clerical)\b/,
    roleCategoryCode: 'administrative_support',
    seniorityCode: 'support',
  },

  {
    test: /\bdirector\b/,
    roleCategoryCode: 'department_head',
    seniorityCode: 'director',
    confidence: 0.7,
  },
  {
    test: /\bchief\b/,
    roleCategoryCode: 'department_head',
    seniorityCode: 'director',
    confidence: 0.6,
  },
  {
    test: /\b(supervisor|foreman|crew-lead)\b/,
    roleCategoryCode: 'supervisor',
    seniorityCode: 'supervisor',
    confidence: 0.7,
  },
  {
    test: /\b(manager|coordinator)\b/,
    roleCategoryCode: 'program_manager',
    seniorityCode: 'manager',
    confidence: 0.6,
  },
  {
    test: /\b(specialist|technician|assistant|aide|officer|associate)\b/,
    roleCategoryCode: 'other',
    seniorityCode: 'staff',
    confidence: 0.4,
  },
];

/** Modifiers that raise or lower seniority regardless of the matched rule. */
export const SENIORITY_MODIFIERS: readonly { test: RegExp; seniorityCode: string }[] = [
  { test: /\b(chief|executive)\b/, seniorityCode: 'executive' },
  {
    test: /\b(deputy|assistant|associate|vice)-(director|administrator|chief)\b/,
    seniorityCode: 'director',
  },
  { test: /\bsenior\b/, seniorityCode: 'senior' },
  { test: /\blead\b/, seniorityCode: 'lead' },
  { test: /\b(junior|entry|trainee|intern|apprentice)\b/, seniorityCode: 'support' },
];

/**
 * Neutral specialty patterns: the subjects, beats and disciplines a public
 * title commonly names. Sector packages add their own through the registry.
 */
export const BASE_SPECIALTY_PATTERNS: readonly RegExp[] = [
  /\b(civil|traffic|environmental|structural|electrical|mechanical|geotechnical)\b/i,
  /\b(water|wastewater|sewer|stormwater|solid waste|streets|bridges)\b/i,
  /\b(zoning|permitting|planning|inspections|code enforcement)\b/i,
  /\b(forensics|narcotics|patrol|traffic enforcement|arson|cyber|homicide)\b/i,
  /\b(payroll|benefits|procurement|grants|budget|treasury|audit)\b/i,
  /\b(epidemiology|immunization|maternal health|behavioral health)\b/i,
];
