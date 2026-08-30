import type { JurisdictionConfig } from './types.js';

export class UnknownJurisdictionError extends Error {
  constructor(key: string, known: readonly string[]) {
    super(
      `no configuration registered for jurisdiction "${key}" (known: ${known.join(', ') || 'none'})`,
    );
    this.name = 'UnknownJurisdictionError';
  }
}

/**
 * Holds the configured jurisdictions.
 *
 * Onboarding a state agency, a county, a city or a federal agency is one
 * registration each. No crawler, adapter, normalization or database code
 * changes, which is the property `tests/extensibility.test.ts` asserts directly.
 */
export class JurisdictionRegistry {
  private readonly byKey = new Map<string, JurisdictionConfig>();

  register(config: JurisdictionConfig): this {
    const key = config.key.toLowerCase();
    if (this.byKey.has(key)) throw new Error(`JurisdictionRegistry: ${key} is already registered`);
    this.byKey.set(key, config);
    return this;
  }

  get(key: string): JurisdictionConfig {
    const config = this.byKey.get(key.toLowerCase());
    if (config === undefined) throw new UnknownJurisdictionError(key, this.keys());
    return config;
  }

  has(key: string): boolean {
    return this.byKey.has(key.toLowerCase());
  }

  keys(): string[] {
    return [...this.byKey.keys()].sort();
  }

  list(): readonly JurisdictionConfig[] {
    return this.keys().map((key) => this.byKey.get(key) as JurisdictionConfig);
  }

  /** Everything configured at one level of government. */
  atLevel(governmentLevelCode: string): readonly JurisdictionConfig[] {
    return this.list().filter((config) => config.governmentLevelCode === governmentLevelCode);
  }
}
