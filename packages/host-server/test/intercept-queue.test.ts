import { describe, expect, test } from "bun:test";
import { AbandonedError, InterceptQueue } from "../src/intercept-queue.ts";

/** A job that finishes only when told to, recording when it started. */
function gate(started: string[], name: string) {
  let finish!: (v: string) => void;
  const done = new Promise<string>((r) => (finish = r));
  return {
    fn: () => {
      started.push(name);
      return done;
    },
    finish: () => finish(name),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("InterceptQueue", () => {
  test("runs in arrival order, no more at once than the concurrency", async () => {
    const started: string[] = [];
    const q = new InterceptQueue(() => 1);
    const jobs = ["p2", "p3", "p4", "p5"].map((n) => gate(started, n));
    const results = jobs.map((j, i) => q.run(`k${i}`, j.fn));
    expect(started).toEqual(["p2"]);
    for (const j of jobs) {
      j.finish();
      await tick();
    }
    expect(await Promise.all(results)).toEqual(["p2", "p3", "p4", "p5"]);
    expect(started).toEqual(["p2", "p3", "p4", "p5"]);
  });

  test("drops a waiting ask whose asker went away, and the next one moves up", async () => {
    const started: string[] = [];
    const q = new InterceptQueue(() => 1);
    const a = gate(started, "a");
    const b = gate(started, "b");
    const c = gate(started, "c");
    const gone = new AbortController();
    const ra = q.run("a", a.fn);
    const rb = q.run("b", b.fn, gone.signal);
    const rc = q.run("c", c.fn);
    gone.abort();
    expect(rb).rejects.toBeInstanceOf(AbandonedError);
    expect(q.queued).toBe(1);
    a.finish();
    await tick();
    expect(started).toEqual(["a", "c"]);
    c.finish();
    expect(await ra).toBe("a");
    expect(await rc).toBe("c");
  });

  test("an ask already aborted never runs", async () => {
    const started: string[] = [];
    const q = new InterceptQueue(() => 1);
    const signal = AbortSignal.abort();
    const r = q.run("a", gate(started, "a").fn, signal);
    expect(r).rejects.toBeInstanceOf(AbandonedError);
    await tick();
    expect(started).toEqual([]);
  });

  test("a started interception is left to finish when its asker goes", async () => {
    const started: string[] = [];
    const q = new InterceptQueue(() => 1);
    const a = gate(started, "a");
    const gone = new AbortController();
    const r = q.run("a", a.fn, gone.signal);
    gone.abort();
    a.finish();
    expect(await r).toBe("a");
  });

  test("asks for one key share an interception, kept while any asker remains", async () => {
    const started: string[] = [];
    const q = new InterceptQueue(() => 1);
    const first = gate(started, "first");
    const shared = gate(started, "shared");
    const one = new AbortController();
    q.run("first", first.fn);
    const r1 = q.run("k", shared.fn, one.signal);
    const r2 = q.run("k", () => Promise.resolve("never"));
    expect(q.queued).toBe(1);
    one.abort();
    expect(q.queued).toBe(1);
    first.finish();
    await tick();
    shared.finish();
    expect(await r2).toBe("shared");
    expect(await r1).toBe("shared");
    expect(started).toEqual(["first", "shared"]);
  });

  test("a failure reaches every asker and frees the slot", async () => {
    const q = new InterceptQueue(() => 1);
    const r = q.run("a", () => Promise.reject(new Error("source down")));
    const next = q.run("b", () => Promise.resolve("b"));
    expect(r).rejects.toThrow("source down");
    expect(await next).toBe("b");
  });
});
