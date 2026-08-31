import type { EmailValidationStatus, Timestamp } from '@public-workforce/shared-types';

export interface ValidationRequestItem {
  /** Our id for the address or candidate being checked. */
  referenceId: string;
  address: string;
}

export interface ValidationResultItem {
  referenceId: string;
  address: string;
  status: EmailValidationStatus;
  /** Provider-specific detail, e.g. "mailbox_not_found", "role_address". */
  subStatus: string | null;
  /** Provider score, normalized to 0..1 when the provider supplies one. */
  score: number | null;
  providerRequestId: string | null;
  raw: Record<string, unknown>;
  validatedAt: Timestamp;
}

export interface ValidationProviderInfo {
  key: string;
  displayName: string;
  /** Documented batch ceiling. The worker chunks requests to respect it. */
  maxBatchSize: number;
  /** True when the provider bills per address checked. */
  billable: boolean;
}

/**
 * Replaceable interface to whichever validation vendor is configured.
 *
 * The platform never talks to a vendor SDK directly. Swapping providers means
 * adding one implementation and changing configuration, and no provider is
 * wired in by default: `NoopValidationProvider` is the shipped implementation
 * so that no credential is required and no spend can happen by accident.
 */
export interface EmailValidationProvider {
  readonly info: ValidationProviderInfo;
  validateBatch(items: readonly ValidationRequestItem[]): Promise<ValidationResultItem[]>;
}

/**
 * Records every address as `unvalidated`.
 *
 * This is the default so that an unconfigured system produces honest data
 * rather than optimistic data: nothing is ever marked valid without a real
 * provider result behind it.
 */
export class NoopValidationProvider implements EmailValidationProvider {
  readonly info: ValidationProviderInfo = {
    key: 'noop',
    displayName: 'No validation provider configured',
    maxBatchSize: 1000,
    billable: false,
  };

  constructor(private readonly now: () => Date = () => new Date()) {}

  validateBatch(items: readonly ValidationRequestItem[]): Promise<ValidationResultItem[]> {
    const validatedAt = this.now().toISOString();
    return Promise.resolve(
      items.map((item) => ({
        referenceId: item.referenceId,
        address: item.address,
        status: 'unvalidated',
        subStatus: 'no_provider_configured',
        score: null,
        providerRequestId: null,
        raw: {},
        validatedAt,
      })),
    );
  }
}

/**
 * Whether a validation result is strong enough to promote an inferred candidate
 * into a first-class email address.
 *
 * `accept_all` deliberately does not qualify: a catch-all domain accepts
 * anything, so it is evidence about the domain, not about the mailbox.
 */
export function qualifiesForPromotion(status: EmailValidationStatus): boolean {
  return status === 'valid';
}

/** Human-readable phrasing that never overstates what we know. */
export function describeValidationStatus(status: EmailValidationStatus): string {
  switch (status) {
    case 'unvalidated':
      return 'not checked';
    case 'valid':
      return 'confirmed deliverable by the validation provider';
    case 'invalid':
      return 'confirmed undeliverable by the validation provider';
    case 'risky':
      return 'flagged risky by the validation provider';
    case 'accept_all':
      return 'domain accepts all mail, mailbox not confirmed';
    case 'unknown':
      return 'provider could not determine a result';
    case 'error':
      return 'validation attempt failed';
  }
}
