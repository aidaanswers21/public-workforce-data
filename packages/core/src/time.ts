import type { Timestamp } from '@public-workforce/shared-types';

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** A frozen clock. Tests use it so timestamps never make assertions flaky. */
export function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`fixedClock: invalid date ${iso}`);
  return () => new Date(date);
}

export function toTimestamp(date: Date): Timestamp {
  return date.toISOString();
}

export function nowTimestamp(clock: Clock = systemClock): Timestamp {
  return toTimestamp(clock());
}

/** Inclusive lower bound, exclusive upper bound, both optional. */
export function isEffectiveAt(
  at: Timestamp,
  effectiveAt: Timestamp,
  expiresAt: Timestamp | null,
): boolean {
  if (at < effectiveAt) return false;
  if (expiresAt !== null && at >= expiresAt) return false;
  return true;
}
