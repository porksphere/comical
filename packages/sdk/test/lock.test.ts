/**
 * Tests for the SDK `Lock` primitive: calls must run one-at-a-time in submission order, each call's
 * own result must come back to its own caller, and a throw must not jam the queue for later callers.
 */
import { describe, expect, test } from "bun:test";
import { Lock } from "../src/lock.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Lock", () => {
  test("serializes overlapping calls in submission order", async () => {
    const lock = new Lock();
    const order: string[] = [];
    const first = deferred<void>();

    const a = lock.run(async () => {
      order.push("a-start");
      await first.promise;
      order.push("a-end");
      return "a";
    });
    const b = lock.run(async () => {
      order.push("b-start");
      return "b";
    });

    // b must not start until a's deferred resolves, even though b has no work to await itself.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    first.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  test("each call resolves with its own result", async () => {
    const lock = new Lock();
    const results = await Promise.all([
      lock.run(() => 1),
      lock.run(() => 2),
      lock.run(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  test("a rejected call doesn't jam the queue for later callers", async () => {
    const lock = new Lock();
    const failing = lock.run(() => {
      throw new Error("boom");
    });
    const next = lock.run(() => "still runs");

    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("still runs");
  });
});
