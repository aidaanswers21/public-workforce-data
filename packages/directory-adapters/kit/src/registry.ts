import type {
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
} from '@public-workforce/shared-types';

export interface AdapterSelection {
  adapter: DirectoryAdapter;
  detection: DetectionResult;
  /** Every adapter's score, highest first. Recorded so a wrong pick is diagnosable. */
  ranked: readonly DetectionResult[];
}

export class UnsupportedPlatformError extends Error {
  constructor(
    readonly url: string,
    readonly ranked: readonly DetectionResult[],
  ) {
    super(`no directory adapter claimed ${url}`);
    this.name = 'UnsupportedPlatformError';
  }
}

/**
 * Holds the available adapters and picks one per page.
 *
 * Registration order does not decide the winner: the highest score above an
 * adapter's own threshold does, with ties broken by registration order so the
 * result is deterministic. An unclaimed page raises `UnsupportedPlatformError`
 * rather than falling through to a guess, which is what lets coverage reporting
 * show real gaps instead of silently bad data.
 */
export class AdapterRegistry {
  private readonly adapters: DirectoryAdapter[] = [];

  register(adapter: DirectoryAdapter): this {
    if (this.adapters.some((existing) => existing.key === adapter.key)) {
      throw new Error(`AdapterRegistry: duplicate adapter key "${adapter.key}"`);
    }
    this.adapters.push(adapter);
    return this;
  }

  get(key: string): DirectoryAdapter | null {
    return this.adapters.find((adapter) => adapter.key === key) ?? null;
  }

  list(): readonly DirectoryAdapter[] {
    return [...this.adapters];
  }

  /** Score every adapter without choosing one. */
  rank(context: DetectionContext): DetectionResult[] {
    return this.adapters
      .map((adapter) => adapter.detect(context))
      .sort((a, b) => b.score - a.score);
  }

  select(context: DetectionContext): AdapterSelection {
    const scored = this.adapters.map((adapter) => ({
      adapter,
      detection: adapter.detect(context),
    }));
    const ranked = [...scored]
      .sort((a, b) => b.detection.score - a.detection.score)
      .map((entry) => entry.detection);

    let best: { adapter: DirectoryAdapter; detection: DetectionResult } | null = null;
    for (const entry of scored) {
      if (entry.detection.score < entry.adapter.detectionThreshold) continue;
      if (best === null || entry.detection.score > best.detection.score) best = entry;
    }
    if (best === null) throw new UnsupportedPlatformError(context.url, ranked);
    return { adapter: best.adapter, detection: best.detection, ranked };
  }

  /** Non-throwing form, for coverage reporting over many targets. */
  trySelect(context: DetectionContext): AdapterSelection | null {
    try {
      return this.select(context);
    } catch {
      return null;
    }
  }
}
