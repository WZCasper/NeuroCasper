// Per-streamer mutex, scoped to ONE call of runScheduledCheck (src/scheduled.ts
// creates a fresh instance at the top of every run and threads it through --
// never a module-level singleton, since there's nothing to protect once the
// run that created it has finished).
//
// Why this exists: parallelizing the account checks (see
// src/lib/concurrency.ts) means two accounts belonging to the SAME streamer
// (e.g. a streamer with both YouTube and TikTok tracked) can now genuinely
// run at the same time within one invocation. If both go live in the same
// 5-minute window, both would call src/lib/publish.ts's publishOrMerge for
// that streamer concurrently -- and publishOrMerge's own "is there already
// an open post?" read is not atomic with its later insert (see its
// comment), so two concurrent callers could both see "no open post yet" and
// each create one, instead of the second one merging into the first.
//
// Routing every publishOrMerge / closeLivePlatform call for a given
// streamer through run() serializes them WITHIN this invocation: the second
// call simply waits for the first to fully finish (including its DB
// writes) before it even starts, so it always sees the first one's result.
// Different streamers are never serialized against each other -- this only
// removes the race, not the parallelism the pool exists for.
//
// This does NOT cover the other source of the same race: a Kick webhook
// (its own, separate Worker invocation, see src/handlers/kick.ts) landing
// while THIS invocation is mid-check for the same streamer's YouTube/TikTok
// account. An in-memory map can't reach across invocations -- that cross-
// invocation case is what src/db.ts's claimPostSlot/releasePostSlot (used
// by publishOrMerge) exists for instead.
export class StreamerSerializer {
  private readonly chains = new Map<number, Promise<void>>();

  run<T>(streamerId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(streamerId) ?? Promise.resolve();
    const result = previous.then(task, task);
    // What's stored for the NEXT caller against this streamerId is a
    // same-shape promise that always resolves, regardless of whether this
    // task succeeded or failed -- so one failure doesn't wedge the chain
    // for later tasks queued against the same streamer. The real
    // success/failure is still visible on `result`, which is what THIS
    // call returns to its own caller.
    this.chains.set(
      streamerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
