import type { StateConfig } from './types.js';

export class UnknownStateError extends Error {
  constructor(code: string, known: readonly string[]) {
    super(`no configuration registered for state "${code}" (known: ${known.join(', ') || 'none'})`);
    this.name = 'UnknownStateError';
  }
}

/**
 * Holds the configured states.
 *
 * Adding a state means registering one config object. No crawler, adapter,
 * normalization or database code changes, which is the property the state
 * onboarding process depends on and that `tests/state-onboarding.test.ts`
 * asserts directly.
 */
export class StateRegistry {
  private readonly byCode = new Map<string, StateConfig>();

  register(config: StateConfig): this {
    const code = config.code.toUpperCase();
    if (this.byCode.has(code)) throw new Error(`StateRegistry: ${code} is already registered`);
    this.byCode.set(code, config);
    return this;
  }

  get(code: string): StateConfig {
    const config = this.byCode.get(code.toUpperCase());
    if (config === undefined) throw new UnknownStateError(code, this.codes());
    return config;
  }

  has(code: string): boolean {
    return this.byCode.has(code.toUpperCase());
  }

  codes(): string[] {
    return [...this.byCode.keys()].sort();
  }

  list(): readonly StateConfig[] {
    return this.codes().map((code) => this.byCode.get(code) as StateConfig);
  }
}
