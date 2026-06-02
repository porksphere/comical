/**
 * Author-side strict typing for bridge settings.
 *
 * `defineSettings([...])` preserves the literal descriptor tuple (via a `const` type parameter,
 * so authors don't need `as const`). `InferSettings<typeof SETTINGS>` then derives the typed
 * settings record — required descriptors become present keys, optional ones become optional, and
 * an `enum`'s value narrows to the union of its option `value`s.
 *
 *   const SETTINGS = defineSettings([
 *     { type: "string", key: "baseUrl", label: "Backend URL", required: true },
 *     { type: "string", key: "apiKey",  label: "API key", secret: true },
 *     { type: "enum",   key: "region",  label: "Region",
 *       options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] },
 *   ]);
 *   type S = InferSettings<typeof SETTINGS>;  // { baseUrl: string; apiKey?: string; region?: "us" | "eu" }
 *   class MyBridge extends BridgeBase<S> { getSettings() { return SETTINGS; } … }
 */
import type { SettingDescriptor, SettingValue } from "@comical/contract";

/** Identity helper that captures the literal descriptor tuple type for inference. */
export function defineSettings<const T extends readonly SettingDescriptor[]>(descriptors: T): T {
  return descriptors;
}

/** The value type a single descriptor resolves to. */
export type SettingValueOf<D> = D extends { type: "string" }
  ? string
  : D extends { type: "number" }
    ? number
    : D extends { type: "boolean" }
      ? boolean
      : D extends { type: "enum"; multiple: true }
        ? string[]
        : D extends { type: "enum"; options: readonly { value: infer V extends string }[] }
          ? V
          : SettingValue;

/** Keys of the descriptors marked `required: true`. */
type RequiredKey<T extends readonly SettingDescriptor[]> = Extract<
  T[number],
  { required: true }
>["key"];

/**
 * Infer the typed settings record from a descriptor tuple. Required descriptors are present;
 * everything else is optional. (Required-presence is the contract the host guarantees before a
 * bridge's content methods run — see the loader's settings enforcement + host gating.)
 */
export type InferSettings<T extends readonly SettingDescriptor[]> = {
  [D in T[number] as D["key"] extends RequiredKey<T> ? D["key"] : never]: SettingValueOf<D>;
} & {
  [D in T[number] as D["key"] extends RequiredKey<T> ? never : D["key"]]?: SettingValueOf<D>;
};
