import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "./concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runWithConcurrency processes every item exactly once", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const seen: number[] = [];
  await runWithConcurrency(items, 3, async (item) => {
    await delay(1);
    seen.push(item);
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("runWithConcurrency never runs more than `limit` workers at once", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  const limit = 4;

  await runWithConcurrency(items, limit, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(5);
    inFlight--;
  });

  assert.ok(maxInFlight <= limit, `expected max ${limit} in flight, saw ${maxInFlight}`);
  assert.equal(maxInFlight, limit, "should actually reach the limit with plenty of items available");
});

test("runWithConcurrency starts a new item as soon as a slot frees, not after a whole batch", async () => {
  // Two workers, three items: item 0 is slow, items 1 and 2 are fast. With
  // fixed-size batching (limit-sized chunks run with Promise.all, then the
  // next chunk starts), item 2 would have to wait for item 0's slow chunk
  // to fully finish. With a real worker pool, whichever of items 1/2 grabs
  // the second slot should start immediately, and the pool's OTHER slot
  // should pick up the next item the moment it's free -- so the second
  // slot processes two items well before the first slot's one slow item
  // finishes.
  const order: string[] = [];
  const items = [
    { id: "slow", ms: 30 },
    { id: "fast-a", ms: 1 },
    { id: "fast-b", ms: 1 },
  ];
  await runWithConcurrency(items, 2, async (item) => {
    await delay(item.ms);
    order.push(item.id);
  });
  // Both fast items must finish before the slow one, regardless of which
  // slot picked up which item first.
  assert.deepEqual(order.slice(0, 2).sort(), ["fast-a", "fast-b"]);
  assert.equal(order[2], "slow");
});

test("runWithConcurrency handles an empty item list", async () => {
  let calls = 0;
  await runWithConcurrency([], 5, async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("runWithConcurrency handles fewer items than the limit", async () => {
  const seen: number[] = [];
  await runWithConcurrency([1, 2], 10, async (item) => {
    seen.push(item);
  });
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test("runWithConcurrency clamps a limit below 1 up to 1 (still processes everything)", async () => {
  const seen: number[] = [];
  await runWithConcurrency([1, 2, 3], 0, async (item) => {
    seen.push(item);
  });
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
});
