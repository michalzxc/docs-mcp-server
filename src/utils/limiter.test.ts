import { describe, expect, it } from "vitest";
import { Limiter } from "./limiter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Limiter", () => {
  it("never exceeds the configured concurrency", async () => {
    const limiter = new Limiter({ maxConcurrency: 2, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(5);
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(limiter.activeCount).toBe(0);
  });

  it("treats concurrency below one as serial", async () => {
    const limiter = new Limiter({ maxConcurrency: 0, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(2);
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it("spaces task starts by the minimum interval", async () => {
    const limiter = new Limiter({ maxConcurrency: 1, minIntervalMs: 25 });
    const starts: number[] = [];

    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.run(async () => {
          starts.push(Date.now());
        }),
      ),
    );

    expect(starts).toHaveLength(3);
    // Allow a little slack: timers fire no earlier than requested, never exactly.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(20);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(20);
  });

  it("releases the slot when a task rejects", async () => {
    const limiter = new Limiter({ maxConcurrency: 1, minIntervalMs: 0 });

    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A failing LLM call must not starve the queue: cleanup keeps going.
    await expect(limiter.run(async () => "second")).resolves.toBe("second");
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it("runs queued tasks in the order they arrived", async () => {
    const limiter = new Limiter({ maxConcurrency: 1, minIntervalMs: 0 });
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await sleep(1);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });
});
