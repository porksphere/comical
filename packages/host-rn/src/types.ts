/**
 * The type contract for embedding the Comical runtime in a React Native / Expo app.
 *
 * The bridge-management surface (`BridgeProvider`/`BridgeSummary`) is re-exported from the real
 * `@comical/host-server/bridge-provider` (Node-free), so an embedder's provider is checked against
 * the exact interface `createRouter` drives — no drift-prone mirror. The RN-specific seams below
 * (the native-module JSON contract, the bundle source, the in-process router adapter) are defined
 * here because they don't exist elsewhere in comical: this package is their canonical home.
 */
import type { BridgeInfo } from "@comical/contract";

export type { BridgeProvider, BridgeSummary, BridgeSource } from "@comical/host-server/bridge-provider";

/**
 * A `Hono`-like app as returned by `@comical/host-server`'s `createRouter` — only `.fetch` is used
 * in-process. Kept as a narrow adapter (rather than `typeof createRouter`) so consumers don't pull
 * Hono's types; the caller passes the real `createRouter` and casts to `CreateRouter`.
 */
export interface EmbeddedRouter {
  fetch(req: Request): Response | Promise<Response>;
}

/** The subset of `@comical/host-server`'s `createRouter` signature the embedded runtime uses. */
export type CreateRouter = (
  manager: import("@comical/host-server/bridge-provider").BridgeProvider,
  opts?: { origin?: string; cors?: boolean },
) => EmbeddedRouter;

/** A fetch-shaped transport: resolves a server-relative path to a `Response`, same contract as `fetch`. */
export type EmbeddedTransport = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The native-module JSON contract — an Expo (or bare-RN) native module wrapping `ComicalBridgeContext`
 * (JSC on iOS, QuickJS on Android). Bundle code runs in a separate JS engine; everything crosses the
 * boundary as JSON. `initBridge` returns the loaded bridge's `{ info, methods }` (see `InitResult`).
 *
 * This is the contract comical's `describeJson`/`callJson` native host implementations are written
 * against; it lives here so the native module and its JS consumers share one definition.
 */
export interface NativeBridgeRuntime {
  initBridge(id: string, code: string, settingsJson: string, networkJson?: string): Promise<string>;
  callBridge(id: string, method: string, argsJson: string): Promise<string>;
  disposeBridge(id: string): void;
}

/** What `initBridge` resolves to (JSON-encoded). */
export interface InitResult {
  info: BridgeInfo;
  /** Method names the loaded bridge implements; omitted by older native builds (see capabilities.ts fallback). */
  methods?: string[];
}

/**
 * An installed bridge's cheap metadata — the `info` a registry index already carries (capabilities,
 * nsfw, icon), so a browse list needs no bundle load. Settings descriptors are NOT here: they
 * require loading the bridge, so the provider fetches them lazily (mirroring how the server's
 * BridgeManager loads a bridge to build its summary).
 */
export interface InstalledBridge {
  info: BridgeInfo;
  source: "local" | "registry";
  availableVersion?: string;
}

/**
 * Supplies installed bridges + their bundle code. The content-only v1 implementation
 * (`RegistryBundleSource`) downloads + verifies + caches bundles from a registry.
 */
export interface BundleSource {
  /** All installed bridges with their index metadata — cheap, no bundle load required. */
  installed(): Promise<InstalledBridge[]>;
  /** The bundle source code for a bridge id; throws with "not found" for an unknown id. */
  resolveBundle(id: string): Promise<string>;
}

/** Minimal per-bridge settings persistence (AsyncStorage-backed in an app; injectable for tests). */
export interface SettingsStore {
  get(id: string): Promise<Record<string, import("@comical/contract").SettingValue>>;
  set(id: string, values: Record<string, import("@comical/contract").SettingValue>): Promise<void>;
}
