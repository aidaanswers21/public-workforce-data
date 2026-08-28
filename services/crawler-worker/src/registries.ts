import { AdapterRegistry } from '@pan/adapter-kit';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import { genericJsonAdapter } from '@pan/adapter-generic-json';
import { StateRegistry } from '@pan/state-kit';
import { texasStateConfig } from '@pan/state-texas';

/**
 * The two registries that make the platform extensible.
 *
 * A new directory platform is one `register` call here plus an adapter package.
 * A new state is one `register` call here plus a config package. Nothing else
 * in the crawler, the schema or the pipeline changes, which is the property
 * `tests/extensibility.test.ts` asserts.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(genericJsonAdapter).register(genericHtmlAdapter);
}

export function buildStateRegistry(): StateRegistry {
  return new StateRegistry().register(texasStateConfig);
}
