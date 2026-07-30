/**
 * A minimal async mutex for serializing operations that must never run concurrently — the classic
 * case is token refresh: two calls that both see an expired token and both fire a refresh race, and
 * whichever response lands second silently clobbers the first (the same class of bug we hit with
 * concurrent AsyncStorage read-modify-writes dropping records). Wrap the refresh in a `Lock` so the
 * second caller waits for the first refresh to finish and reuses its result instead of racing it.
 */
export class Lock {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Run `fn` once every earlier call on this lock has finished, and resolve/reject with its result.
   * Calls queue in order; a throw in one call never jams the ones behind it.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
