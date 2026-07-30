/**
 * Runs an async op after any prior op queued under the same key has settled, so a composite
 * read-modify-write against a shared per-id doc (settings: get, merge, set) never interleaves with
 * another one for the same id. `SettingsStore.get`/`set` are each a single round trip — the race
 * lives in the *composition*, e.g. `EmbeddedBridgeProvider.updateSettings` reading, merging, then
 * writing back, concurrently with a tracker's OAuth-token drain doing the same for the same id.
 * Without this, whichever `set` lands last silently wins, dropping the other write — the same
 * failure mode `serializeAsyncMethods` (comical-app's AsyncStorage stores) fixes for a single doc,
 * scoped here per key so unrelated ids never block each other.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.tails.set(key, next.then(
      () => {},
      () => {},
    ));
    return next;
  }
}
