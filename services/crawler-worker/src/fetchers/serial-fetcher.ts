import type { Fetcher, FetchOutcome, FetchRequest } from '@public-workforce/shared-types';

/** A rendered page may issue many requests; one domain still gets one at a time. */
export class SerialFetcher implements Fetcher {
  readonly key = 'serial';
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: Fetcher) {}
  fetch(request: FetchRequest): Promise<FetchOutcome> {
    const next = this.tail.then(() => this.inner.fetch(request));
    this.tail = next.catch(() => undefined);
    return next;
  }
}
