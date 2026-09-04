/**
 * The narrow slice of a Postgres driver this package needs.
 *
 * Keeping it this small means the same repositories run against `pg` in
 * production and against an in-process Postgres in tests, with no mocking of
 * SQL behaviour anywhere.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  /** Multi-statement execution, used by the migration runner. */
  exec?(sql: string): Promise<unknown>;
  /**
   * Run a block atomically, when the driver can.
   *
   * Optional because the interface is deliberately narrow, and `runAtomically`
   * falls back to explicit BEGIN and COMMIT for a client that does not offer
   * one. Callers that need atomicity should use `runAtomically` rather than
   * reaching for this directly.
   */
  transaction?<T>(run: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface Transactional extends SqlClient {
  transaction<T>(run: (client: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * Run a block atomically, whatever the client offers.
 *
 * Prefers the driver's own transaction handling, which knows about pooling and
 * nesting, and falls back to explicit BEGIN and COMMIT. Used wherever a partial
 * write would be worse than no write: applying a migration, and recording a
 * complaint together with the suppression it produces.
 */
export async function runAtomically<T>(
  client: SqlClient,
  run: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (typeof client.transaction === 'function') return client.transaction(run);
  return withTransaction(client, run);
}

/** Run a block inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  client: SqlClient,
  run: (client: SqlClient) => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** Execute a multi-statement script, preferring the driver's own exec. */
export async function execScript(client: SqlClient, sql: string): Promise<void> {
  if (typeof client.exec === 'function') {
    await client.exec(sql);
    return;
  }
  await client.query(sql);
}
