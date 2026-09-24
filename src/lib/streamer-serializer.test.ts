import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamerSerializer } from "./streamer-serializer.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("StreamerSerializer never overlaps two tasks for the same streamerId", async () => {
  const serializer = new StreamerSerializer();
  let running = 0;
  let overlapped = false;
  const order: string[] = [];

  async function task(label: string, ms: number): Promise<void> {
    running++;
    if (running > 1) overlapped = true;
    order.push(`start:${label}`);
    await delay(ms);
    order.push(`end:${label}`);
    running--;
  }

  await Promise.all([
    serializer.run(1, () => task("a", 15)),
    serializer.run(1, () => task("b", 1)),
    serializer.run(1, () => task("c", 1)),
  ]);

  assert.equal(overlapped, false, "tasks for the same streamerId must never run concurrently");
  // Strictly in submission order: each waits for the previous to fully finish.
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("StreamerSerializer runs tasks for different streamerIds concurrently", async () => {
  const serializer = new StreamerSerializer();
  let concurrentAtPeak = 0;
  let peak = 0;

  async function task(ms: number): Promise<void> {
    concurrentAtPeak++;
    peak = Math.max(peak, concurrentAtPeak);
    await delay(ms);
    concurrentAtPeak--;
  }

  await Promise.all([
    serializer.run(1, () => task(20)),
    serializer.run(2, () => task(20)),
    serializer.run(3, () => task(20)),
  ]);

  assert.equal(peak, 3, "different streamerIds should not be serialized against each other");
});

test("StreamerSerializer: a rejected task doesn't block the next task queued for the same streamerId", async () => {
  const serializer = new StreamerSerializer();
  const secondRan = { value: false };

  const firstResult = serializer.run(1, async () => {
    throw new Error("boom");
  });
  const secondResult = serializer.run(1, async () => {
    secondRan.value = true;
    return "ok";
  });

  await assert.rejects(firstResult, /boom/);
  assert.equal(await secondResult, "ok");
  assert.equal(secondRan.value, true);
});

test("StreamerSerializer.run resolves/rejects with the task's own outcome", async () => {
  const serializer = new StreamerSerializer();
  assert.equal(await serializer.run(5, async () => 42), 42);
  await assert.rejects(
    serializer.run(5, async () => {
      throw new Error("nope");
    }),
    /nope/,
  );
});
