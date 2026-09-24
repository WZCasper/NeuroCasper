// Bounded-concurrency "worker pool": runs `worker` over every item in
// `items`, with at most `limit` calls in flight at once, and immediately
// starts the next item as soon as any slot frees up (rather than waiting
// for a whole fixed-size batch to finish before starting the next one --
// that wastes concurrency whenever items take different amounts of time,
// which is the normal case here: a YouTube check that hits its fast path
// is much quicker than one that also has to walk the RSS feed).
//
// Used by src/scheduled.ts to check every tracked YouTube/TikTok account in
// parallel instead of one at a time. The default limit (see
// DEFAULT_CONCURRENCY below) is deliberately not "as many as possible": a
// single Worker invocation may have at most 6 simultaneous outgoing
// connections in flight (Cloudflare's documented per-request limit, same
// on the Free and Paid plans -- https://developers.cloudflare.com/workers/platform/limits/,
// "Simultaneous outgoing connections/request"). Each account check makes
// its outgoing fetch() calls one at a time (see checkYoutubeAccount /
// checkTiktokAccount in src/scheduled.ts -- nothing inside a single
// account's own check runs concurrently with itself), so running exactly 6
// accounts through this pool at once keeps the Worker at, not over, that
// ceiling.
export const DEFAULT_CONCURRENCY = 6;

/** `worker` must not reject -- callers are responsible for catching and
 * logging their own errors (see src/scheduled.ts's runAccountCheck), the
 * same way the original sequential for-loop this replaced did per account.
 * This keeps the pool itself simple and reusable: one item throwing never
 * stops the other in-flight items or the ones still queued. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  let cursor = 0;
  async function pump(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      // Unreachable given the bounds check just above -- items.length
      // doesn't change while this runs -- but noUncheckedIndexedAccess
      // (tsconfig.json) still types items[i] as T | undefined, so this
      // keeps the function honestly typed without a non-null assertion.
      if (item === undefined) return;
      await worker(item);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => pump()));
}
