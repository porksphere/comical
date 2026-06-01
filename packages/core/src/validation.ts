/** Boundary validation: every value a bridge returns is parsed against a contract schema. */
import type { z } from "zod";
import { BridgeValidationError } from "./errors.ts";

export function validate<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeValidationError(
      `${context}: bridge returned data that failed validation`,
      result.error.issues,
    );
  }
  return result.data;
}
