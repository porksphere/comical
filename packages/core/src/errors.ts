/** Typed error hierarchy so hosts can distinguish *why* a bridge failed. */

export class ComicalError extends Error {
  override readonly name: string = "ComicalError";
}

/** The bridge bundle could not be evaluated or did not export a factory. */
export class BridgeLoadError extends ComicalError {
  override readonly name = "BridgeLoadError";
}

/** The bridge's declared info/contractVersion is invalid or incompatible with this runtime. */
export class BridgeContractError extends ComicalError {
  override readonly name = "BridgeContractError";
}

/** A bridge returned data that failed schema validation at the boundary. */
export class BridgeValidationError extends ComicalError {
  override readonly name = "BridgeValidationError";
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
  }
}

/** A bridge call exceeded its time budget. */
export class BridgeTimeoutError extends ComicalError {
  override readonly name = "BridgeTimeoutError";
}

/** A bridge threw while executing one of its methods. */
export class BridgeRuntimeError extends ComicalError {
  override readonly name = "BridgeRuntimeError";
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}
