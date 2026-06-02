/**
 * Loads a bridge bundle into a sandbox, gates its capabilities, validates its self-description
 * and contract compatibility, and returns a `LoadedBridge` whose every method is wrapped with a
 * timeout and output validation.
 */
import {
  type Bridge,
  type BridgeFactory,
  type BridgeInfo,
  type ListOptions,
  type SearchOptions,
  bridgeInfoSchema,
  CONTRACT_VERSION,
  chapterSchema,
  filterSchema,
  filterValueSchema,
  type HostCapabilities,
  isContractCompatible,
  pageSchema,
  pagedResultsSchema,
  seriesEntrySchema,
  seriesInfoSchema,
  seriesListSchema,
  settingDescriptorSchema,
  sortOptionSchema,
  sortSelectionSchema,
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
import type { RateLimitOptions } from "./net/rate-limiter.ts";
import { evaluateBundle, NodeVmEvaluator } from "./sandbox.ts";
import { resolveSettings } from "./settings.ts";

/** Boundary schema for the search options bag (filters + sort). */
const searchOptionsSchema = z.object({
  filters: z.array(filterValueSchema).optional(),
  sort: sortSelectionSchema.optional(),
});

/** Boundary schema for the list options bag (in-list query + filters + sort). */
const listOptionsSchema = z.object({
  query: z.string().optional(),
  filters: z.array(filterValueSchema).optional(),
  sort: sortSelectionSchema.optional(),
});
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
  //    `settings` is a mutable copy so defaults/coercions applied after instantiation are visible
  //    to the bridge, which reads `host.settings` lazily by reference.
  const gatedNetwork = createGatedNetwork(opts.capabilities.network, opts.network ?? {});
  const gated: HostCapabilities = {
    ...opts.capabilities,
    network: gatedNetwork.network,
    settings: { ...opts.capabilities.settings },
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

  // 4b. Apply the bridge's declared rate limit as the default. Precedence per key:
  //     explicit host override (already set on the limiter) > info.rateLimit > runtime default.
  if (info.rateLimit) {
    const hostSet = opts.network?.rateLimit ?? {};
    const declared: Partial<RateLimitOptions> = {};
    if (info.rateLimit.maxConcurrent !== undefined && hostSet.maxConcurrent === undefined) {
      declared.maxConcurrent = info.rateLimit.maxConcurrent;
    }
    if (info.rateLimit.minIntervalMs !== undefined && hostSet.minIntervalMs === undefined) {
      declared.minIntervalMs = info.rateLimit.minIntervalMs;
    }
    gatedNetwork.setRateLimit(declared);
  }

  // 5. Enforce settings: apply declared defaults + coerce/validate present values (in place, so
  //    the bridge's lazy `host.settings` reads see the result). Throws on an invalid present value;
  //    a merely-missing required setting is NOT fatal here (discovery must still load the bridge).
  if (raw.getSettings) {
    const descriptors = validate(z.array(settingDescriptorSchema), raw.getSettings(), "getSettings");
    const { values } = resolveSettings(gated.settings, descriptors);
    gated.settings = values;
  }

  // 6. Wrap every method with timeout + output validation.
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
  };

  if (raw.getLists) {
    bridge.getLists = (q) => call("getLists", z.array(seriesListSchema), () => raw.getLists!(q));
  }
  if (raw.getListItems) {
    bridge.getListItems = (listId, p, opts) => {
      const options =
        opts === undefined ? undefined : (validate(listOptionsSchema, opts, "list options") as ListOptions);
      return call("getListItems", entryPage, () => raw.getListItems!(listId, p, options));
    };
  }
  if (raw.getSearchResults) {
    bridge.getSearchResults = (q, p, opts) => {
      // Validate the search-options INPUT (filters + sort) at the boundary.
      const options =
        opts === undefined ? undefined : (validate(searchOptionsSchema, opts, "search options") as SearchOptions);
      return call("getSearchResults", entryPage, () => raw.getSearchResults!(q, p, options));
    };
  }
  if (raw.getFilters) {
    bridge.getFilters = () => call("getFilters", z.array(filterSchema), () => raw.getFilters!());
  }
  if (raw.getSortOptions) {
    bridge.getSortOptions = () =>
      call("getSortOptions", z.array(sortOptionSchema), () => raw.getSortOptions!());
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
