/**
 * Minimal in-process counters.
 *
 * Deliberately not wired to a metrics backend yet: the foundation needs run
 * statistics to be reportable and testable, not shipped. See docs/OPERATIONS.md.
 */
export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly timers = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  observeDuration(name: string, milliseconds: number): void {
    const bucket = this.timers.get(name);
    if (bucket) bucket.push(milliseconds);
    else this.timers.set(name, [milliseconds]);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; durations: Record<string, DurationSummary> } {
    const durations: Record<string, DurationSummary> = {};
    for (const [name, values] of this.timers) {
      const sorted = [...values].sort((a, b) => a - b);
      const total = sorted.reduce((sum, v) => sum + v, 0);
      durations[name] = {
        count: sorted.length,
        totalMs: total,
        meanMs: sorted.length > 0 ? total / sorted.length : 0,
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) ?? 0,
      };
    }
    return { counters: Object.fromEntries(this.counters), durations };
  }
}

export interface DurationSummary {
  count: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
