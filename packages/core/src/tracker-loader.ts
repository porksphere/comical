/**
 * Loads a tracker bundle into a sandbox, gates its capabilities, validates its self-description,
 * and returns a `LoadedTracker` whose every method is wrapped with a timeout and output validation.
 *
 * Mirrors `loadBridge` exactly — same sandbox model, same rate-limit application, same
 * settings resolution, same timeout + validation wrapping.
 */
import {
  type HostCapabilities,
  type PagedResults,
  type Tracker,
  type TrackerFactory,
  type TrackerInfo,
  type TrackerLibraryEntry,
  type TrackerSearchResult,
  trackerInfoSchema,
  trackerLibraryEntrySchema,
  trackerSearchResultSchema,
  settingDescriptorSchema,
  pagedResultsSchema,
  CONTRACT_VERSION,
  isContractCompatible,
} from "@comical/contract";
import { z } from "zod";
import { BridgeContractError, BridgeLoadError, BridgeRuntimeError, ComicalError } from "./errors.ts";
import type { BundleEvaluator } from "./evaluator.ts";
import { createGatedNetwork, type GatedNetworkOptions } from "./net/gated-network.ts";
import type { RateLimitOptions } from "./net/rate-limiter.ts";
import { resolveSettings } from "./settings.ts";
import { errorMessage, withTimeout } from "./util.ts";
import { validate } from "./validation.ts";
import { DEFAULT_LIMITS, type RuntimeLimits } from "./loader.ts";

/** A fully-wrapped tracker: same surface as `Tracker`, but timeout-bounded and output-validated. */
export type LoadedTracker = Tracker;

export interface LoadTrackerOptions {
  code: string;
  capabilities: HostCapabilities;
  expectedId?: string;
  limits?: Partial<RuntimeLimits>;
  network?: GatedNetworkOptions;
  evaluator?: BundleEvaluator;
  runtimeContractVersion?: string;
}

let defaultEvaluatorFactory: ((evalTimeoutMs: number) => BundleEvaluator) | undefined;

/** Register the default evaluator for tracker loading (same as bridge — typically `NodeVmEvaluator`). */
export function setDefaultTrackerEvaluator(factory: (evalTimeoutMs: number) => BundleEvaluator): void {
  defaultEvaluatorFactory = factory;
}

export function loadTracker(opts: LoadTrackerOptions): LoadedTracker {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const runtimeVersion = opts.runtimeContractVersion ?? CONTRACT_VERSION;

  const evaluator = opts.evaluator ?? defaultEvaluatorFactory?.(limits.evalTimeoutMs);
  if (!evaluator) {
    throw new BridgeLoadError(
      "no bundle evaluator: pass `evaluator` to loadTracker, or import from `@comical/core`, or call setDefaultTrackerEvaluator().",
    );
  }
  const { exports } = evaluator.evaluate(opts.code, opts.capabilities.log);
  const factory = extractFactory(exports);

  const gatedNetwork = createGatedNetwork(opts.capabilities.network, opts.network ?? {});
  const gated: HostCapabilities = {
    ...opts.capabilities,
    network: gatedNetwork.network,
    settings: { ...opts.capabilities.settings },
  };

  let raw: Tracker;
  try {
    raw = factory(gated);
  } catch (cause) {
    throw new BridgeLoadError(`tracker factory threw: ${errorMessage(cause)}`);
  }

  const info: TrackerInfo = validate(
    trackerInfoSchema,
    (raw as { info?: unknown } | null | undefined)?.info,
    "TrackerInfo",
  );
  if (opts.expectedId !== undefined && info.id !== opts.expectedId) {
    throw new BridgeContractError(`tracker id mismatch: expected "${opts.expectedId}", got "${info.id}"`);
  }
  if (!isContractCompatible(info.contractVersion, runtimeVersion)) {
    throw new BridgeContractError(
      `tracker "${info.id}" targets contract ${info.contractVersion}, incompatible with runtime ${runtimeVersion}`,
    );
  }

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

  if (raw.getSettings) {
    const descriptors = validate(z.array(settingDescriptorSchema), raw.getSettings(), "getSettings");
    const { values } = resolveSettings(gated.settings, descriptors);
    gated.settings = values;
  }

  return wrapTracker(raw, info, limits.callTimeoutMs);
}

function extractFactory(exports: unknown): TrackerFactory {
  const def = (exports as { default?: unknown } | null | undefined)?.default;
  if (typeof def !== "function") {
    throw new BridgeLoadError("tracker bundle must default-export a factory function: (host) => Tracker");
  }
  return def as TrackerFactory;
}

function wrapTracker(raw: Tracker, info: TrackerInfo, timeoutMs: number): LoadedTracker {
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

  const tracker: LoadedTracker = { info };

  if (raw.getSettings) {
    const getSettings = raw.getSettings.bind(raw);
    tracker.getSettings = () => validate(z.array(settingDescriptorSchema), getSettings(), "getSettings");
  }
  if (raw.getLibrary) {
    const entryPage = pagedResultsSchema(trackerLibraryEntrySchema);
    tracker.getLibrary = (page) => call("getLibrary", entryPage, () => raw.getLibrary!(page));
  }
  if (raw.updateEntry) {
    tracker.updateEntry = (externalId, update) =>
      call("updateEntry", z.void(), () => raw.updateEntry!(externalId, update));
  }
  if (raw.search) {
    const searchPage = pagedResultsSchema(trackerSearchResultSchema);
    tracker.search = (q, page) => call("search", searchPage, () => raw.search!(q, page));
  }

  return tracker;
}
