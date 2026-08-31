/**
 * The public professional data boundary.
 *
 * This platform collects public professional information about public
 * employees. It does not collect anything below, and these are checks rather
 * than documentation: the ingestion pipeline runs them over every extracted
 * value and drops what they catch, counting the drops so the boundary is
 * visible in reporting rather than invisible in a policy document.
 */
export const PROHIBITED_DATA_KINDS = [
  'government_id_number',
  'date_of_birth',
  'financial_account',
  'medical',
  'home_address',
  'family_information',
  'personal_email',
  'credential',
  'student_information',
  'guardian_information',
] as const;
export type ProhibitedDataKind = (typeof PROHIBITED_DATA_KINDS)[number];

export interface ProhibitedDataFinding {
  kind: ProhibitedDataKind;
  /** The field the value arrived in, for the operator's report. */
  field: string;
  /** Why it was caught. Never the offending value itself. */
  reason: string;
}

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/;
const ROUTING_LABEL = /\b(routing|account)\s*(number|no\.?|#)\b/i;
const DOB_LABEL = /\b(date\s*of\s*birth|birth\s*date|dob|born\s*on)\b/i;
const DATE_VALUE = /\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b/;
const MEDICAL_LABEL =
  /\b(diagnosis|medical\s*record|health\s*condition|prescription|patient\s*id|disability\s*status)\b/i;
const HOME_ADDRESS_LABEL = /\b(home|residential|personal)\s*(address|street|residence)\b/i;
const FAMILY_LABEL =
  /\b(spouse|husband|wife|child(ren)?|dependent|emergency\s*contact|next\s*of\s*kin)\b/i;
const CREDENTIAL_LABEL =
  /\b(password|passcode|api[\s_-]?key|secret|token|pin\b|security\s*question)\b/i;

/**
 * Student and guardian detection, deliberately narrow.
 *
 * The word "student" is everywhere in legitimate public employment: Director of
 * Student Services, Student Affairs Coordinator, Dean of Students. Rejecting
 * the word would throw away real employees and would train whoever reads the
 * drop counter to ignore it.
 *
 * So these match two things only, and never the bare word:
 *
 *   - a field that names a student or guardian as the person it describes, such
 *     as `student_name`, `student_id`, `pupil_dob`, `parent_email`;
 *   - a value that identifies a student by school position, such as a grade or
 *     a graduating class attached to a person.
 *
 * A title is never scanned for these, because a title is a description of a job
 * rather than of a person.
 */
const STUDENT_SUBJECT_LABEL =
  /\b(student|pupil|learner|scholar)[\s_-]*(name|id|number|email|address|phone|photo|record|roster|schedule|grade|gpa|dob|birth|iep|enrol?lment)\b/i;
const STUDENT_POSSESSIVE_LABEL =
  /\b(name|id|number|email|address|phone|photo|record|roster|schedule|grade|gpa|dob)[\s_-]*of[\s_-]*(student|pupil)\b/i;
const STUDENT_VALUE =
  /\b(class\s*of\s*(19|20)\d{2}|(\d{1,2})(st|nd|rd|th)\s*grade\s*student|student\s*id\s*[:#]?\s*\w+)\b/i;
const GUARDIAN_LABEL =
  /\b(parent|guardian|caregiver|custodian[\s_-]*of[\s_-]*record|mother|father)[\s_-]*(name|id|email|address|phone|contact|information)\b/i;

/** Fields that describe a job rather than a person, so the student rules skip them. */
const ROLE_DESCRIPTION_FIELDS = new Set([
  'title_published',
  'title',
  'role',
  'position',
  'job_title',
  'department_published',
  'department',
  'organization_published',
  'organization',
  'unit',
]);

/**
 * Free email providers.
 *
 * A public employee's personal address is out of scope even when a directory
 * publishes it, so these are dropped rather than stored. The list is not
 * exhaustive and does not need to be: it catches the common cases, and anything
 * it misses is still governed by the rule that only work addresses are exported.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'aim.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'fastmail.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'juno.com',
  'roadrunner.com',
  'optonline.net',
  'windstream.net',
  'frontier.com',
  'me.co',
  'inbox.com',
]);

export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Scan one published value for anything outside the boundary.
 *
 * Both the field label and the value are considered, because a directory that
 * publishes a date under a "DOB" heading is out of scope whatever the date
 * looks like, and a bare government id number is out of scope whatever it is
 * labelled.
 */
export function scanForProhibitedData(field: string, value: string): ProhibitedDataFinding[] {
  const findings: ProhibitedDataFinding[] = [];
  // Field labels arrive in snake_case and kebab-case from both extraction and
  // official files, so "date_of_birth" must read the same as "date of birth".
  const label = field.toLowerCase().replace(/[_-]+/g, ' ');

  if (SSN_PATTERN.test(value) || /\b(ssn|social\s*security)\b/i.test(label)) {
    findings.push({
      kind: 'government_id_number',
      field,
      reason: 'value or label indicates a government identification number',
    });
  }
  if (DOB_LABEL.test(label) || (DOB_LABEL.test(value) && DATE_VALUE.test(value))) {
    findings.push({
      kind: 'date_of_birth',
      field,
      reason: 'label or value indicates a date of birth',
    });
  }
  if (
    ROUTING_LABEL.test(label) ||
    (CARD_PATTERN.test(value) && /\b(card|account|bank)\b/i.test(label))
  ) {
    findings.push({
      kind: 'financial_account',
      field,
      reason: 'label or value indicates a financial account',
    });
  }
  if (MEDICAL_LABEL.test(label) || MEDICAL_LABEL.test(value)) {
    findings.push({
      kind: 'medical',
      field,
      reason: 'label or value indicates medical information',
    });
  }
  if (HOME_ADDRESS_LABEL.test(label)) {
    findings.push({
      kind: 'home_address',
      field,
      reason: 'label indicates a home rather than office address',
    });
  }
  if (FAMILY_LABEL.test(label)) {
    findings.push({
      kind: 'family_information',
      field,
      reason: 'label indicates family or emergency contact information',
    });
  }
  if (CREDENTIAL_LABEL.test(label)) {
    findings.push({ kind: 'credential', field, reason: 'label indicates authentication material' });
  }

  // Job descriptions legitimately contain these words. "Director of Student
  // Services" is an employee, and treating the word as the signal would drop
  // them.
  if (!ROLE_DESCRIPTION_FIELDS.has(field)) {
    if (
      STUDENT_SUBJECT_LABEL.test(label) ||
      STUDENT_POSSESSIVE_LABEL.test(label) ||
      STUDENT_VALUE.test(value)
    ) {
      findings.push({
        kind: 'student_information',
        field,
        reason: 'label or value identifies a student rather than an employee',
      });
    }
    if (GUARDIAN_LABEL.test(label)) {
      findings.push({
        kind: 'guardian_information',
        field,
        reason: 'label identifies a parent or guardian rather than an employee',
      });
    }
  }

  return findings;
}

export interface BoundaryScanResult {
  /** Fields safe to store. */
  allowed: Record<string, string>;
  findings: ProhibitedDataFinding[];
}

/**
 * Filter a published record down to what may be stored.
 *
 * Returns the findings as well as the allowed fields, because a dropped value
 * is a fact worth counting: a source that keeps offering out-of-scope fields is
 * one somebody should look at, not one to quietly keep reading.
 */
export function applyDataBoundary(
  fields: Readonly<Record<string, string | null>>,
): BoundaryScanResult {
  const allowed: Record<string, string> = {};
  const findings: ProhibitedDataFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value.length === 0) continue;
    const found = scanForProhibitedData(field, value);
    if (found.length > 0) {
      findings.push(...found);
      continue;
    }
    allowed[field] = value;
  }

  return { allowed, findings };
}
