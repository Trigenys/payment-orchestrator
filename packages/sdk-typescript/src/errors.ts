import type { ApiErrorPayload } from "@trigenys/payments-contracts";

export interface TrigenysPaymentsErrorOptions {
  readonly status?: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly cause?: unknown;
}

export class TrigenysPaymentsError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;

  constructor(message: string, options: TrigenysPaymentsErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "TrigenysPaymentsError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  static fromApi(status: number, error: ApiErrorPayload): TrigenysPaymentsError {
    return new TrigenysPaymentsError(error.message, {
      status,
      code: error.code,
      details: error.details,
      requestId: error.requestId
    });
  }
}
