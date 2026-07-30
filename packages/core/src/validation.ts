/**
 * Boundary validation. Values cross the bridge boundary in both directions, so there are two
 * entry points that differ only in wording — blaming the bridge for a bad *request* the host built
 * sends whoever reads the error looking in the wrong place.
 */
import type { z } from "zod";
import { BridgeValidationError } from "./errors.ts";

const detail = (issues: z.ZodIssue[]): string =>
  issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");

/** Parse a value a bridge **returned** against its contract schema. */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeValidationError(
      `${context}: bridge returned data that failed validation — ${detail(result.error.issues)}`,
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * Parse a value the host is **passing in** (a request object). Rejecting here means the bridge was
 * never called, so the message says so rather than implicating the bridge.
 */
export function validateInput<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeValidationError(
      `${context}: rejected before calling the bridge — ${detail(result.error.issues)}`,
      result.error.issues,
    );
  }
  return result.data;
}
