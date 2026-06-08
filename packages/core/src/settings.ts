/**
 * Settings enforcement shared by the loader (and reusable by hosts).
 *
 * `resolveSettings` takes the raw user-supplied values + the bridge's descriptors and returns a
 * normalized value map: declared defaults applied for unset keys, trivial coercions performed
 * (`"40" → 40`, `"true" → true`, so the CLI's string `--set` and lenient JSON bodies work), and
 * present values validated against their descriptor (type + enum membership). It throws
 * `BridgeSettingsError` on an *invalid present value*, but never on a merely-missing required one —
 * discovery must still be able to load a bridge to read its info. Missing-required is reported
 * separately via `missingRequired`.
 */
import type { SettingDescriptor, SettingValue } from "@comical/contract";
import { BridgeSettingsError } from "./errors.ts";

export interface ResolveResult {
  values: Record<string, SettingValue>;
  /** Required keys with neither a supplied value nor a declared default. */
  missingRequired: string[];
}

/** Coerce + validate a single value against its descriptor. Returns the value or an error string. */
function coerce(
  descriptor: SettingDescriptor,
  raw: SettingValue,
): { value: SettingValue } | { error: string } {
  switch (descriptor.type) {
    case "string": {
      if (typeof raw === "string") return { value: raw };
      if (typeof raw === "number" || typeof raw === "boolean") return { value: String(raw) };
      return { error: `"${descriptor.key}" must be a string` };
    }
    case "number": {
      let n: number | undefined;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) n = Number(raw);
      if (n === undefined) return { error: `"${descriptor.key}" must be a number` };
      if (descriptor.min !== undefined && n < descriptor.min) return { error: `"${descriptor.key}" must be ≥ ${descriptor.min}` };
      if (descriptor.max !== undefined && n > descriptor.max) return { error: `"${descriptor.key}" must be ≤ ${descriptor.max}` };
      return { value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: `"${descriptor.key}" must be a boolean` };
    }
    case "enum": {
      const allowed = new Set(descriptor.options.map((o) => o.value));
      if (descriptor.multiple) {
        const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : null;
        if (!arr) return { error: `"${descriptor.key}" must be an array of option values` };
        const bad = arr.filter((v) => !allowed.has(v));
        if (bad.length > 0) return { error: `"${descriptor.key}" has invalid option(s): ${bad.join(", ")}` };
        return { value: arr };
      }
      if (typeof raw !== "string" || !allowed.has(raw)) {
        return { error: `"${descriptor.key}" must be one of: ${[...allowed].join(", ")}` };
      }
      return { value: raw };
    }
    case "oauth-pin":
    case "oauth-callback": {
      // The stored value is the access token (or a JSON blob) — treat it as a plain string.
      if (typeof raw === "string") return { value: raw };
      return { error: `"${descriptor.key}" must be a string token` };
    }
  }
}

/**
 * Validate + coerce a user-submitted partial settings input against the descriptors, WITHOUT
 * applying defaults. Rejects unknown keys and invalid values (throws `BridgeSettingsError`).
 * Returns the coerced values to persist. Used by hosts on a settings-update request.
 */
export function validateSettingsInput(
  input: Readonly<Record<string, SettingValue>>,
  descriptors: readonly SettingDescriptor[],
): Record<string, SettingValue> {
  const byKey = new Map(descriptors.map((d) => [d.key, d]));
  const out: Record<string, SettingValue> = {};
  const issues: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const descriptor = byKey.get(key);
    if (!descriptor) {
      issues.push(`unknown setting "${key}"`);
      continue;
    }
    const result = coerce(descriptor, value);
    if ("error" in result) issues.push(result.error);
    else out[key] = result.value;
  }

  if (issues.length > 0) {
    throw new BridgeSettingsError(`invalid settings:\n  - ${issues.join("\n  - ")}`, issues);
  }
  return out;
}

export function resolveSettings(
  raw: Readonly<Record<string, SettingValue>>,
  descriptors: readonly SettingDescriptor[],
): ResolveResult {
  const values: Record<string, SettingValue> = { ...raw };
  const issues: string[] = [];
  const missingRequired: string[] = [];

  for (const d of descriptors) {
    const supplied = values[d.key];
    if (supplied === undefined || supplied === "") {
      const defaultValue = "default" in d ? d.default : undefined;
      if (defaultValue !== undefined) {
        values[d.key] = defaultValue;
      } else {
        delete values[d.key];
        if (d.required) missingRequired.push(d.key);
      }
      continue;
    }
    const result = coerce(d, supplied);
    if ("error" in result) issues.push(result.error);
    else values[d.key] = result.value;
  }

  if (issues.length > 0) {
    throw new BridgeSettingsError(`invalid settings:\n  - ${issues.join("\n  - ")}`, issues);
  }
  return { values, missingRequired };
}
