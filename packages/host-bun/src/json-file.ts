/**
 * Crash-safe JSON documents on disk — the one read/write path every server-side store goes through.
 *
 * The bug this exists to prevent: a store that reads with `catch { return fallback }` turns a
 * truncated or garbled file into "empty", and its next flush then writes that empty view over the
 * real data. So:
 *
 * - **Reads never swallow.** A missing file is the fallback; a file that won't parse (or that the
 *   caller's `decode` rejects) is moved aside to `<path>.corrupt-<ts>` — kept for recovery, and
 *   named so `.json` directory listings skip it — before the fallback is returned. Any other IO
 *   error (permissions, a dying disk) throws: the store must not run on a view it couldn't read.
 * - **Writes are atomic.** Serialized to a unique temp file, fsynced, then renamed over the target,
 *   so a crash leaves the old document or the new one, never half of each.
 * - **Writes to one path are serialized**, process-wide, and a queued write decides what to write
 *   when it RUNS — the latest state, or a delete — so two overlapping flushes can't land out of order.
 *
 * `node:fs` only (no Bun APIs): the desktop app runs these stores under Electron's Node.
 */
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

type Log = (message: string, error?: unknown) => void;

const defaultLog: Log = (message, error) => console.warn(message, error ?? "");

/** Returned by a `JsonDoc` encoder to delete the file instead of writing it. */
export const DELETE_FILE: unique symbol = Symbol("DELETE_FILE");

export interface ReadJsonOptions<T> {
  /** Raw JSON → value. Throw to reject the document as corrupt (it is quarantined). */
  decode?: ((raw: unknown) => T) | undefined;
  log?: Log | undefined;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

// ── Per-path serialization ──────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` after every earlier task queued on `path` has settled (whether or not it failed). Every
 * write, delete and quarantine of a path goes through here, across all store instances.
 */
export function onPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(path, tail);
  void tail.then(() => {
    if (chains.get(path) === tail) chains.delete(path);
  });
  return run;
}

// ── Reads ───────────────────────────────────────────────────────────────────

type Attempt<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "corrupt"; error: unknown };

async function attempt<T>(path: string, decode: ((raw: unknown) => T) | undefined): Promise<Attempt<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    const raw: unknown = JSON.parse(text);
    return { kind: "ok", value: decode ? decode(raw) : (raw as T) };
  } catch (error) {
    return { kind: "corrupt", error };
  }
}

/**
 * Read a JSON document. Missing → `fallback`. Unparseable or rejected by `decode` → quarantined to
 * `<path>.corrupt-<timestamp>`, then `fallback`. Any other read error throws.
 */
export async function readJsonFile<T>(path: string, fallback: T, options: ReadJsonOptions<T> = {}): Promise<T> {
  const first = await attempt(path, options.decode);
  if (first.kind === "ok") return first.value;
  if (first.kind === "missing") return fallback;
  // Re-check under the path's queue before moving anything: a write queued ahead of us may have
  // just replaced the bad document with a good one, which must not be the file we move aside.
  return onPath(path, async () => {
    const again = await attempt(path, options.decode);
    if (again.kind === "ok") return again.value;
    if (again.kind === "missing") return fallback;
    const aside = `${path}.corrupt-${Date.now()}`;
    await withRetry(() => rename(path, aside));
    (options.log ?? defaultLog)(`json-file: ${path} was unreadable; moved it to ${aside} and started empty`, again.error);
    return fallback;
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

// Windows can refuse a rename/remove for a moment while something (an indexer, antivirus, another
// reader) has the file open. Transient; retry a few times before giving up.
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

async function withRetry(fn: () => Promise<void>): Promise<void> {
  for (let attemptNo = 0; ; attemptNo++) {
    try {
      return await fn();
    } catch (err) {
      if (attemptNo >= 8 || !RETRYABLE.has(errorCode(err) ?? "")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attemptNo));
    }
  }
}

async function writeNow(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await withRetry(() => rename(tmp, path));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function deleteNow(path: string): Promise<void> {
  await withRetry(() => rm(path, { force: true }));
}

/** Atomically replace `path` with `value` as JSON (queued behind any pending write to it). */
export function writeJsonFile(path: string, value: unknown): Promise<void> {
  return onPath(path, () => writeNow(path, value));
}

/** Remove `path` if present (queued behind any pending write to it). */
export function deleteJsonFile(path: string): Promise<void> {
  return onPath(path, () => deleteNow(path));
}

// ── Cached documents ────────────────────────────────────────────────────────

export interface JsonDocOptions<T> {
  /** The value when the file is missing (or was quarantined). Called fresh each time. */
  empty: () => T;
  /** Raw JSON → value. Throw to reject the document as corrupt. */
  decode?: (raw: unknown) => T;
  /** Value → JSON to store, or `DELETE_FILE` to remove the file. Defaults to the value itself. */
  encode?: (value: T) => unknown;
  log?: Log | undefined;
}

/**
 * One JSON file cached in memory: loaded once (concurrent first callers share the load), mutated in
 * place, and flushed through the path's queue. The flush encodes the value as it is when the write
 * RUNS, so a burst of mutations can't land on disk out of order.
 */
export class JsonDoc<T> {
  private value: T | undefined;
  private loaded = false;
  private loading: Promise<T> | undefined;

  constructor(
    readonly path: string,
    private readonly options: JsonDocOptions<T>,
  ) {}

  /** The cached value (loading it on first use). Mutate it only through `update`. */
  get(): Promise<T> {
    if (this.loaded) return Promise.resolve(this.value as T);
    if (!this.loading) {
      const load = readJsonFile(this.path, this.options.empty(), { decode: this.options.decode, log: this.options.log }).then(
        (value) => {
          if (!this.loaded) {
            this.value = value;
            this.loaded = true;
          }
          this.loading = undefined;
          return this.value as T;
        },
        (err: unknown) => {
          this.loading = undefined; // a failed load isn't cached — the next call retries
          throw err;
        },
      );
      this.loading = load;
    }
    return this.loading;
  }

  /** Mutate the loaded value (synchronously) and persist it. `mutate`'s result is returned. */
  // Both read `this.value` AFTER the await, never the value `get()` resolved with: another caller's
  // `transform` may have swapped it in between, and that swap must not be lost.
  async update<R>(mutate: (value: T) => R): Promise<R> {
    await this.get();
    const result = mutate(this.value as T);
    await this.flush();
    return result;
  }

  /** Swap the loaded value for `next(current)` (synchronously) and persist it. */
  async transform(next: (value: T) => T): Promise<void> {
    await this.get();
    this.value = next(this.value as T);
    await this.flush();
  }

  /** Replace the whole value and persist it. Waits for the load, so a load can't overwrite it. */
  replace(value: T): Promise<void> {
    return this.transform(() => value);
  }

  /** Persist the current value. */
  flush(): Promise<void> {
    return onPath(this.path, async () => {
      const encoded = this.options.encode ? this.options.encode(this.value as T) : this.value;
      if (encoded === DELETE_FILE) await deleteNow(this.path);
      else await writeNow(this.path, encoded);
    });
  }
}

// ── Shape guards for `decode` ───────────────────────────────────────────────

/** Accept a plain JSON object (`{ ... }`), reject anything else as corrupt. */
export function asJsonRecord<V>(raw: unknown): Record<string, V> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected a JSON object");
  return raw as Record<string, V>;
}

/** Accept a JSON array, reject anything else as corrupt. */
export function asJsonArray<V>(raw: unknown): V[] {
  if (!Array.isArray(raw)) throw new Error("expected a JSON array");
  return raw as V[];
}

/** A `JsonDoc` holding a `Map` stored as a JSON object. */
export function jsonMapDoc<V>(path: string, options: { deleteWhenEmpty?: boolean; log?: Log | undefined } = {}): JsonDoc<Map<string, V>> {
  return new JsonDoc<Map<string, V>>(path, {
    empty: () => new Map(),
    decode: (raw) => new Map(Object.entries(asJsonRecord<V>(raw))),
    encode: (map) => (options.deleteWhenEmpty && map.size === 0 ? DELETE_FILE : Object.fromEntries(map)),
    log: options.log,
  });
}
