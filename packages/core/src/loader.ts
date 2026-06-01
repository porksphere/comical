/**
 * Loads a bridge bundle into a sandbox, gates its capabilities, validates its self-description
 * and contract compatibility, and returns a `LoadedBridge` whose every method is wrapped with a
 * timeout and output validation.
 */
import {
  type Bridge,
  type BridgeFactory,
  type BridgeInfo,
  bridgeInfoSchema,
  CONTRACT_VERSION,
  chapterSchema,
  filterSchema,
  type HostCapabilities,
  homeSectionSchema,
  isContractCompatible,
  seriesEntrySchema,
  seriesInfoSchema,
  pageSchema,
  pagedResultsSchema,
  settingDescriptorSchema,
  tagSchema,
} from "@comical/contract";
import { z } from "zod";
import {
  BridgeContractError,
  BridgeLoadError,
  BridgeRuntimeError,
  ComicalError,
} from "./errors.ts";
import type { BundleEvaluator } from "./evaluator.ts";
import { createGatedNetwork, type GatedNetworkOptions } from "./net/gated-network.ts";
import { evaluateBundle, NodeVmEvaluator } from "./sandbox.ts";
import { errorMessage, withTimeout } from "./util.ts";
import { validate } from "./validation.ts";

export interface RuntimeLimits {
  /** Budget for the synchronous evaluation of the bundle. */
  evalTimeoutMs: number;
  /** Budget for each (async) bridge method call. */
  callTimeoutMs: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  evalTimeoutMs: 5000,
  callTimeoutMs: 30000,
};

export interface LoadBridgeOptions {
  /** The bridge bundle source (CJS, as produced by `bun build --format=cjs`). */
  code: string;
  /** Raw host capabilities; the loader gates `network` before injecting them. */
  capabilities: HostCapabilities;
  /** If set, the loaded bridge's `info.id` must equal this (registry integrity check). */
  expectedId?: string;
  limits?: Partial<RuntimeLimits>;
  network?: GatedNetworkOptions;
  /**
   * The JS engine used to evaluate the bridge bundle. Defaults to `NodeVmEvaluator` (node:vm).
   * Supply a platform-specific evaluator for browser (FunctionEvaluator), iOS (JSC), or
   * Android (QuickJS) hosts.
   */
  evaluator?: BundleEvaluator;
  /** Override the runtime contract version (testing). Defaults to CONTRACT_VERSION. */
  runtimeContractVersion?: string;
}

/** A fully-wrapped bridge: same surface as `Bridge`, but timeout-bounded and output-validated. */
export type LoadedBridge = Bridge;

export function loadBridge(opts: LoadBridgeOptions): LoadedBridge {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const runtimeVersion = opts.runtimeContractVersion ?? CONTRACT_VERSION;

  // 1. Evaluate the bundle in isolation and extract the factory.
  const evaluator = opts.evaluator ?? new NodeVmEvaluator(limits.evalTimeoutMs);
  const { exports } = evaluator.evaluate(opts.code, opts.capabilities.log);
  const factory = extractFactory(exports);

  // 2. Gate the network capability (rate-limit + cache) before the bridge can touch it.
  const gated: HostCapabilities = {
    ...opts.capabilities,
    network: createGatedNetwork(opts.capabilities.network, opts.network ?? {}),
  };

  // 3. Instantiate the bridge.
  let raw: Bridge;
  try {
    raw = factory(gated);
  } catch (cause) {
    throw new BridgeLoadError(`bridge factory threw: ${errorMessage(cause)}`);
  }

  // 4. Validate self-description and contract compatibility.
  const info: BridgeInfo = validate(
    bridgeInfoSchema,
    (raw as { info?: unknown } | null | undefined)?.info,
    "BridgeInfo",
  );
  if (opts.expectedId !== undefined && info.id !== opts.expectedId) {
    throw new BridgeContractError(
      `bridge id mismatch: expected "${opts.expectedId}", got "${info.id}"`,
    );
  }
  if (!isContractCompatible(info.contractVersion, runtimeVersion)) {
    throw new BridgeContractError(
      `bridge "${info.id}" targets contract ${info.contractVersion}, ` +
        `incompatible with runtime ${runtimeVersion}`,
    );
  }

  // 5. Wrap every method with timeout + output validation.
  return wrapBridge(raw, info, limits.callTimeoutMs);
}

function extractFactory(exports: unknown): BridgeFactory {
  const def = (exports as { default?: unknown } | null | undefined)?.default;
  if (typeof def !== "function") {
    throw new BridgeLoadError(
      "bridge bundle must default-export a factory function: (host) => Bridge",
    );
  }
  return def as BridgeFactory;
}

function wrapBridge(raw: Bridge, info: BridgeInfo, timeoutMs: number): LoadedBridge {
  const call = async <S extends z.ZodTypeAny>(
    label: string,
    schema: S,
    fn: () => unknown,
  ): Promise<z.infer<S>> => {
    let result: unknown;
    try {
      result = await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    } catch (cause) {
      if (cause instanceof ComicalError) throw cause;
      throw new BridgeRuntimeError(`${label} threw: ${errorMessage(cause)}`, cause);
    }
    return validate(schema, result, label);
  };

  const entryPage = pagedResultsSchema(seriesEntrySchema);

  const bridge: LoadedBridge = {
    info,
    getSeriesDetails: (id) => call("getSeriesDetails", seriesInfoSchema, () => raw.getSeriesDetails(id)),
    getChapters: (id) => call("getChapters", z.array(chapterSchema), () => raw.getChapters(id)),
    getChapterPages: (m, c) =>
      call("getChapterPages", z.array(pageSchema), () => raw.getChapterPages(m, c)),
    getSearchResults: (q, p, f) =>
      call("getSearchResults", entryPage, () => raw.getSearchResults(q, p, f)),
  };

  if (raw.getHomeSections) {
    bridge.getHomeSections = () =>
      call("getHomeSections", z.array(homeSectionSchema), () => raw.getHomeSections!());
  }
  if (raw.getPopular) {
    bridge.getPopular = (p) => call("getPopular", entryPage, () => raw.getPopular!(p));
  }
  if (raw.getLatest) {
    bridge.getLatest = (p) => call("getLatest", entryPage, () => raw.getLatest!(p));
  }
  if (raw.getFilters) {
    bridge.getFilters = () => call("getFilters", z.array(filterSchema), () => raw.getFilters!());
  }
  if (raw.getTags) {
    bridge.getTags = () => call("getTags", z.array(tagSchema), () => raw.getTags!());
  }
  if (raw.getSettings) {
    const getSettings = raw.getSettings.bind(raw);
    bridge.getSettings = () =>
      validate(z.array(settingDescriptorSchema), getSettings(), "getSettings");
  }

  return bridge;
}
