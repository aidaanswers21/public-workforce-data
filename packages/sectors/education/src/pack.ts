import type { SectorPack } from '@public-workforce/taxonomy';

/**
 * Public education as one supported vertical.
 *
 * Everything education-specific lives here: its organization types, its
 * identifier systems, its role vocabulary and its title rules. The neutral core
 * has no knowledge of any of it, so education can be extended, corrected or
 * removed without touching a line of crawler, schema or pipeline code.
 */
export const educationSectorPack: SectorPack = {
  key: 'education',
  displayName: 'Public education',
  description:
    'Public school districts, schools, charter organizations and education service agencies.',

  /**
   * Education work, at whatever level of government performs it.
   *
   * Scoped by sector and not by level, because that is what education is: an
   * independent district is a special district, a dependent one is part of a
   * city or county, and a state education agency is a state body. All three do
   * education-sector work and all three should read a school directory the same
   * way. Scoping by sector also keeps these rules off general-government
   * records at the same levels, so a county's Veterans Counselor is never
   * classified as a school counsellor.
   */
  appliesTo: { sectorCodes: ['education'], governmentLevelCodes: null },

  explorerPresets: [
    {
      key: 'schools',
      name: 'Schools',
      singularName: 'School',
      description:
        'Explore official school directory records, enrollment, staffing, locations, websites, and provenance.',
      organizationTypeCodes: ['school'],
      sectorCodes: ['education'],
      sourceKeys: ['nces-ccd-school-directory-2024-25'],
      attributeColumns: [
        { key: 'enrollment', label: 'Students enrolled', format: 'integer' },
        { key: 'teacherFte', label: 'Teacher FTE', format: 'decimal' },
        { key: 'totalStaffFte', label: 'Total staff FTE', format: 'decimal' },
        { key: 'lowGrade', label: 'Low grade', format: 'text' },
        { key: 'highGrade', label: 'High grade', format: 'text' },
        { key: 'schoolYear', label: 'School year', format: 'text' },
      ],
    },
    {
      key: 'school-districts',
      name: 'School districts',
      singularName: 'School district',
      description:
        'Explore official district directory records, enrollment, staffing, locations, websites, and provenance.',
      organizationTypeCodes: ['school_district'],
      sectorCodes: ['education'],
      sourceKeys: ['nces-ccd-lea-directory-2024-25'],
      attributeColumns: [
        { key: 'enrollment', label: 'Students enrolled', format: 'integer' },
        { key: 'teacherFte', label: 'Teacher FTE', format: 'decimal' },
        { key: 'totalStaffFte', label: 'Total staff FTE', format: 'decimal' },
        { key: 'schoolYear', label: 'School year', format: 'text' },
      ],
    },
  ],

  /**
   * Education organization types.
   *
   * Every one of these is education-sector, and none of them has a fixed
   * government level. An independent school district is a special district; a
   * dependent one is a department of a city, a county or a state. The level is
   * a fact about how a particular body is constituted, so it comes from the
   * source rather than from the type, and these defaults are null wherever the
   * real world varies.
   */
  organizationTypes: [
    {
      code: 'school_district',
      name: 'School district',
      description:
        'A local education agency governing one or more schools. Independent in most states, a unit of a general-purpose government in others, so its government level is recorded per organization.',
      defaultGovernmentLevelCode: null,
      defaultSectorCode: 'education',
      typicallySubordinate: false,
    },
    {
      code: 'school',
      name: 'School',
      description:
        'An individual school. Organizationally part of a district; physically located in a county and a municipality. Takes the government level of the body that operates it.',
      defaultGovernmentLevelCode: null,
      defaultSectorCode: 'education',
      typicallySubordinate: true,
    },
    {
      code: 'charter_organization',
      name: 'Charter organization',
      description: 'A charter management or holding organization operating one or more schools.',
      defaultGovernmentLevelCode: null,
      defaultSectorCode: 'education',
      typicallySubordinate: false,
    },
    {
      code: 'education_service_agency',
      name: 'Education service agency',
      description:
        'A regional service centre or intermediate unit serving several districts. Usually a special district, occasionally a state body.',
      defaultGovernmentLevelCode: 'special_district',
      defaultSectorCode: 'education',
      typicallySubordinate: false,
    },
    {
      code: 'state_education_agency',
      name: 'State education agency',
      description:
        'The state body overseeing public education. A state-level organization doing education-sector work.',
      defaultGovernmentLevelCode: 'state',
      defaultSectorCode: 'education',
      typicallySubordinate: false,
    },
  ],

  identifierSystems: [
    {
      code: 'nces_district_id',
      name: 'NCES district identifier (LEAID)',
      description: 'Federal local education agency identifier.',
      appliesTo: 'organization',
      pattern: '^\\d{7}$',
      authority: 'U.S. National Center for Education Statistics',
    },
    {
      code: 'nces_school_id',
      name: 'NCES school identifier (NCESSCH)',
      description: 'Federal school identifier.',
      appliesTo: 'organization',
      pattern: '^\\d{12}$',
      authority: 'U.S. National Center for Education Statistics',
    },
    {
      code: 'state_education_org_id',
      name: 'State education organization identifier',
      description: 'The identifier a state education agency assigns to a district or school.',
      appliesTo: 'organization',
      pattern: null,
      authority: 'Varies by state',
    },
  ],

  geographicAreaTypes: [
    {
      code: 'attendance_area',
      name: 'Attendance area',
      description:
        'A school attendance boundary. Geographic, and unrelated to the organizational hierarchy.',
    },
    {
      code: 'elementary_school_district_area',
      name: 'Elementary school district area',
      description: 'Census geographic area for an elementary school district.',
    },
    {
      code: 'secondary_school_district_area',
      name: 'Secondary school district area',
      description: 'Census geographic area for a secondary school district.',
    },
    {
      code: 'unified_school_district_area',
      name: 'Unified school district area',
      description: 'Census geographic area for a unified school district.',
    },
    {
      code: 'school_district_administrative_area',
      name: 'School district administrative area',
      description: 'Census geographic area used for school district administration.',
    },
  ],

  jobFamilies: [
    { code: 'instruction', name: 'Instruction', description: 'Classroom and instructional roles.' },
    {
      code: 'student_support',
      name: 'Student support',
      description: 'Counselling, health, and support services for learners.',
    },
  ],

  roleCategories: [
    {
      code: 'district_superintendent',
      name: 'Superintendent',
      description: 'Chief executive of a school district.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'district_leadership',
      name: 'District leadership',
      description: 'Deputy, assistant and associate superintendents and cabinet officers.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'school_principal',
      name: 'Principal',
      description: 'Head of an individual school.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'assistant_principal',
      name: 'Assistant principal',
      description: 'Assistant, associate or vice principal.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'school_leadership',
      name: 'School leadership',
      description: 'Deans and other campus leadership.',
      jobFamilyCode: 'leadership',
    },
    {
      code: 'teacher',
      name: 'Teacher',
      description: 'Classroom teacher at any grade or subject.',
      jobFamilyCode: 'instruction',
    },
    {
      code: 'instructional_support',
      name: 'Instructional support',
      description: 'Instructional coaches, specialists and interventionists.',
      jobFamilyCode: 'instruction',
    },
    {
      code: 'special_education',
      name: 'Special education',
      description: 'Special education teachers, diagnosticians and therapists.',
      jobFamilyCode: 'instruction',
    },
    {
      code: 'paraprofessional',
      name: 'Paraprofessional',
      description: 'Instructional aides and paraprofessionals.',
      jobFamilyCode: 'instruction',
    },
    {
      code: 'substitute',
      name: 'Substitute',
      description: 'Substitute and relief staff.',
      jobFamilyCode: 'instruction',
    },
    {
      code: 'school_counselor',
      name: 'Counselor',
      description: 'Guidance and academic counsellors.',
      jobFamilyCode: 'student_support',
    },
    {
      code: 'school_psychologist',
      name: 'School psychologist',
      description: 'Psychologists and behavioural specialists.',
      jobFamilyCode: 'student_support',
    },
    {
      code: 'school_nurse',
      name: 'School nurse',
      description: 'Campus health staff.',
      jobFamilyCode: 'student_support',
    },
    {
      code: 'librarian_media',
      name: 'Librarian and media',
      description: 'Librarians and media specialists.',
      jobFamilyCode: 'student_support',
    },
    {
      code: 'coach_athletics',
      name: 'Athletics',
      description: 'Coaches, athletic directors and trainers.',
      jobFamilyCode: 'student_support',
    },
    {
      code: 'fine_arts',
      name: 'Fine arts',
      description: 'Band, choir, orchestra, theatre and visual arts staff.',
      jobFamilyCode: 'instruction',
    },
  ],

  titleRules: [
    {
      test: /\b(deputy|associate|assistant)-superintendent\b/,
      roleCategoryCode: 'district_leadership',
      seniorityCode: 'executive',
    },
    {
      test: /\bsuperintendent-of-schools\b|\bschool-superintendent\b/,
      roleCategoryCode: 'district_superintendent',
      seniorityCode: 'executive',
    },
    {
      test: /\b(assistant|associate|vice)-principal\b/,
      roleCategoryCode: 'assistant_principal',
      seniorityCode: 'manager',
    },
    {
      // "Principal" is a job in a school and a seniority prefix everywhere
      // else. A bare match claimed Principal Architect and Principal
      // Scientist, so the rule is now the school senses only: the word
      // standing alone, or naming a school it leads.
      test: /^principal$|\b(school|campus|building|site)-principal\b|\bprincipal-of-the?-\w+/,
      roleCategoryCode: 'school_principal',
      seniorityCode: 'manager',
    },
    {
      test: /\b(dean-of-students|dean-of-instruction|head-of-school)\b/,
      roleCategoryCode: 'school_leadership',
      seniorityCode: 'manager',
    },
    {
      test: /\b(athletic|athletics)-(director|coordinator)\b/,
      roleCategoryCode: 'coach_athletics',
      seniorityCode: 'director',
    },
    {
      test: /\b(head-)?coach\b|\bathletic-trainer\b/,
      roleCategoryCode: 'coach_athletics',
      seniorityCode: 'staff',
    },
    {
      test: /\b(special-education|sped|special-ed|diagnostician|life-skills|resource-teacher)\b/,
      roleCategoryCode: 'special_education',
      seniorityCode: 'staff',
    },
    {
      test: /\b(speech-language|slp|occupational-therapist|physical-therapist|audiologist)\b/,
      roleCategoryCode: 'special_education',
      seniorityCode: 'staff',
    },
    {
      // A bare `counselor` claimed a county's Veterans Counselor, so the
      // school senses are named explicitly instead.
      test: /\b(school|guidance|academic|college|career|crisis)-counselor\b|^counselor$/,
      roleCategoryCode: 'school_counselor',
      seniorityCode: 'staff',
    },
    {
      test: /\b(school-psychologist|lssp|behavior-specialist)\b/,
      roleCategoryCode: 'school_psychologist',
      seniorityCode: 'staff',
    },
    {
      test: /\b(school-nurse|health-(aide|clerk)|campus-nurse)\b/,
      roleCategoryCode: 'school_nurse',
      seniorityCode: 'staff',
    },
    {
      test: /\b(library-media|media-specialist|school-librarian|campus-librarian|teacher-librarian)\b/,
      roleCategoryCode: 'librarian_media',
      seniorityCode: 'staff',
    },
    {
      test: /\b(band|choir|orchestra|theatre|theater|fine-arts|drama)-(director|teacher)\b/,
      roleCategoryCode: 'fine_arts',
      seniorityCode: 'staff',
    },
    {
      test: /\b(instructional-(coach|specialist|technologist)|curriculum|academic-coach|interventionist)\b/,
      roleCategoryCode: 'instructional_support',
      seniorityCode: 'staff',
    },
    {
      // `instructor` alone claimed a district's Fitness Instructor. Teaching
      // titles are named directly; a bare instructor falls through to the
      // neutral base, which is the honest answer for a role that exists in
      // parks departments and school districts alike.
      test: /\b(teacher|educator|faculty|classroom-instructor|lead-instructor)\b/,
      roleCategoryCode: 'teacher',
      seniorityCode: 'staff',
    },
    {
      test: /\b(paraprofessional|para-educator|teacher-(aide|assistant)|instructional-aide)\b/,
      roleCategoryCode: 'paraprofessional',
      seniorityCode: 'support',
    },
    { test: /\bsubstitute\b/, roleCategoryCode: 'substitute', seniorityCode: 'support' },
    {
      test: /\b(cafeteria|child-nutrition|lunchroom)\b/,
      roleCategoryCode: 'food_services',
      seniorityCode: 'support',
    },
    {
      test: /\bbus-(driver|monitor)\b/,
      roleCategoryCode: 'transportation_operations',
      seniorityCode: 'support',
    },
  ],

  titleAbbreviations: [
    { pattern: /\bsped\b/gi, expansion: 'Special Education' },
    { pattern: /\bela\b/gi, expansion: 'ELA' },
    { pattern: /\bpe\b/gi, expansion: 'Physical Education' },
    { pattern: /\bgt\b/gi, expansion: 'Gifted and Talented' },
    { pattern: /\bprin\b\.?/gi, expansion: 'Principal' },
    { pattern: /\bsupt\b\.?/gi, expansion: 'Superintendent' },
  ],

  specialtyPatterns: [
    /\b(math(?:ematics)?|science|biology|chemistry|physics|english|reading|writing|history|spanish|french|art|music|band|choir|orchestra|algebra|geometry|calculus)\b/i,
    /\b(pre-?k(?:indergarten)?|kindergarten|\d{1,2}(?:st|nd|rd|th))\b/i,
  ],

  vocabulary: {
    headingTerms: ['faculty', 'faculty and staff', 'our teachers', 'campus staff', 'school staff'],
    urlHints: [
      { pattern: '/(faculty|faculty-and-staff)(/|$)', weight: 0.9 },
      { pattern: '/(our-)?(teachers|educators)(/|$)', weight: 0.7 },
      { pattern: '/(campus|school)-(staff|directory)(/|$)', weight: 0.85 },
    ],
    sharedInboxLocalParts: [
      'principal',
      'superintendent',
      'registrar',
      'attendance',
      'counseling',
      'athletics',
      'specialeducation',
      'sped',
      'transcripts',
      'enrollment',
      'registration',
      'pta',
      'pto',
      'boosters',
      'frontoffice',
    ],
    organizationLabelWords: [
      'school',
      'campus',
      'academy',
      'elementary',
      'middle',
      'high',
      'preschool',
    ],
    titleIndicatorTerms: [
      'teacher',
      'principal',
      'superintendent',
      'counselor',
      'paraprofessional',
      'instructor',
      'coach',
      'educator',
      'aide',
    ],
    organizationFieldAliases: ['school', 'school_name', 'schoolname', 'campus', 'campus_name'],
    organizationNameSuffixes: [
      'independent school district',
      'unified school district',
      'consolidated school district',
      'school district',
      'public schools',
      'isd',
      'usd',
      'cisd',
      'schools',
      'elementary school',
      'middle school',
      'high school',
      'junior high school',
    ],
  },
};
