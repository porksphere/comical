/**
 * A server as hub AND device: its own library syncs through the hub it serves, so a phone's push
 * lands in it and its own writes reach the phone.
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { entryKey, InMemoryLibraryStore, Library } from "@comical/library";
import { librarySyncStore, SyncEngine, wrapLibraryStore } from "@comical/sync";
import { createSyncHost } from "../src/sync-host.ts";

const DIR = join(import.meta.dir, ".tmp-sync-host");
const quiet = { error: () => {} };

afterEach(() => rm(DIR, { recursive: true, force: true }));

function phone(backend: ReturnType<typeof createSyncHost>["backend"]) {
  const inner = new InMemoryLibraryStore();
  const engine = new SyncEngine({ store: librarySyncStore(inner), backend, device: "phone", newDeviceId: () => "phone-2" });
  return { inner, engine, library: new Library(wrapLibraryStore(inner, engine)) };
}

describe("createSyncHost", () => {
  test("a phone's push lands in the server's library, and the server's writes reach the phone", async () => {
    const host = createSyncHost({ dir: DIR, store: new InMemoryLibraryStore(), log: quiet });
    const serverLib = new Library(host.store);
    await host.ready;
    const p = phone(host.backend);

    const c = await p.library.createCollection("From phone");
    await p.engine.sync();
    await host.flush();
    expect((await serverLib.getCollections()).map((x) => x.name)).toEqual(["From phone"]);

    await serverLib.collectSeries({ bridgeId: "b", seriesId: "s" }, { seriesTitle: "S", collectionIds: [c.id] });
    await host.flush();
    await p.engine.sync();
    expect(await p.library.isCollected(entryKey("b", "s"))).toBe(true);
  });

  test("a fresh hub starts from the library the server already has", async () => {
    const existing = new InMemoryLibraryStore();
    await existing.putCollections([{ id: "c", name: "Already here", order: 0 }]);
    const host = createSyncHost({ dir: DIR, store: existing, log: quiet });
    await host.ready;
    const p = phone(host.backend);
    await p.engine.sync();
    expect((await p.library.getCollections()).map((x) => x.name)).toEqual(["Already here"]);
  });

  test("a restart carries on as the same device from its saved state", async () => {
    const store = new InMemoryLibraryStore();
    const first = createSyncHost({ dir: DIR, store, log: quiet });
    await new Library(first.store).createCollection("One");
    await first.flush();

    const second = createSyncHost({ dir: DIR, store, log: quiet });
    await second.ready;
    expect(second.engine.deviceId).toBe(first.engine.deviceId);
    await new Library(second.store).createCollection("Two");
    await second.flush();

    const p = phone(second.backend);
    await p.engine.sync();
    expect((await p.library.getCollections()).map((x) => x.name).sort()).toEqual(["One", "Two"]);
  });
});
