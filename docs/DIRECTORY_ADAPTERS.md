# Directory adapters

## The contract

`DirectoryAdapter` in `@pan/shared-types`:

```ts
interface DirectoryAdapter {
  readonly key: string;
  readonly version: string; // semver, bumped on behaviour change
  readonly displayName: string;
  readonly detectionThreshold: number; // score below which it does not claim a page
  readonly requiresBrowser: boolean;

  detect(ctx: DetectionContext): DetectionResult;
  discoverDirectories(page: FetchedPage, ctx: AdapterContext): readonly DiscoveredDirectory[];
  extractListing(page: FetchedPage, ctx: AdapterContext): ListingExtraction;
  extractProfile(page: FetchedPage, ctx: AdapterContext): ExtractedPersonRecord | null;
  discoverPagination(page: FetchedPage, ctx: AdapterContext): PaginationPlan;
}
```

An adapter reports only what a page published. Name splitting, title
normalization, email classification, identity resolution and storage all happen
downstream, so an adapter cannot invent structure the source did not contain.

## Adding one

1. Create `packages/directory-adapters/<platform>/` with a `package.json`, a
   `tsconfig.json` referencing `shared-types`, `core`, `extraction` and `kit`,
   and add it to the root `tsconfig.json` and `vitest.config.ts` aliases.
2. Implement the interface. Use `buildPersonRecord` from `@pan/adapter-kit`
   rather than constructing records by hand: it handles email decoding, shared
   inbox detection, phone normalization and deterministic record keys
   identically on every platform.
3. Save at least one representative fixture under
   `tests/fixtures/directory-platforms/<platform>/`, with the expected output
   declared in the test.
4. Write a test that runs `checkAdapterContract` over every fixture.
5. Register it in `services/crawler-worker/src/registries.ts`.

Nothing else changes. `tests/extensibility.test.ts` asserts that.

## Detection and selection

`AdapterRegistry.select` scores every adapter and picks the highest above its
own threshold, ties broken by registration order so the result is
deterministic. A page no adapter claims raises `UnsupportedPlatformError`, and
the discovery worker records the target as `unsupported_platform` rather than
falling through to a guess. That is what makes coverage reporting show real
gaps instead of quietly bad data.

Register specific platforms before generic ones. `generic-html` has a low
threshold (0.25) on purpose: it is the long-tail fallback and should lose to any
adapter that actually recognizes the page.

## Pagination

`PaginationPlan` covers numbered pages, next links, offset and page parameters,
cursor APIs, load-more controls, infinite scroll endpoints, and alphabetical,
department and school filters. Each request carries a `token`.

The engine keys loop protection on the resolved destination URL (plus a hash of
the request body, for APIs that paginate by POSTing a cursor), and it claims the
seed up front, so a "next" link that eventually points back at page one is
caught. Kinds that walk a sequence halt on a revisit; numbered pagers and filter
lists skip the duplicate and continue.

A directory that can only be searched, with no enumerable listing, is reported
as such in `ListingExtraction.warnings` rather than being guessed at.

## What the contract tests check

`checkAdapterContract` in `@pan/adapter-kit` enforces what types cannot:

- `detect` returns this adapter's key and a score in 0..1, deterministically
- `extractListing` is deterministic for the same input
- record keys are unique within a page and stable across extractions
- `empty` agrees with the record count
- every record has a published name, a confidence in 0..1 and a known
  extraction method
- every email is syntactically valid, lower-cased and not repeated on a record
- pagination tokens are unique and non-empty, and every URL resolves
- `discoverPagination` agrees with what `extractListing` returned
- the adapter did not mutate the page body

Determinism and record-key stability are the load-bearing ones: idempotent
recrawls depend entirely on an unchanged page producing identical record keys.

## Shipped adapters

**`generic-html`** (threshold 0.25). Strategies in descending order of
reliability, first non-empty wins: JSON-LD and microdata, then tables, then card
and list groups, then definition lists, then mailto harvesting. The mailto
fallback attaches a warning and low confidence, because it exists so an
unparseable page still yields something reviewable, not so it can be exported
unexamined.

**`generic-json`** (threshold 0.4). Locates a person-shaped collection inside
whatever envelope an API uses, maps common field aliases, and paginates by
cursor, explicit next URL, offset/limit or page/total_pages. It exists partly to
serve API-backed directories and partly as the worked example that adding a
platform touches nothing outside its own package.

## Versioning

Bump `version` whenever extraction behaviour changes. It is recorded on
`directory_platforms` so a record can be traced to the adapter version that
produced it.
