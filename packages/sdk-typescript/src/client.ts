import type {
  ApiErrorResponse,
  ApiSuccess,
  CreateMerchantRequest,
  CreatePaymentRequest,
  CreatePaymentResponse,
  CreateProviderAccountRequest,
  MerchantView,
  PaymentView,
  ProviderAccountView,
  VerifyPaymentResponse
} from "@trigenys/payments-contracts";
import { TrigenysPaymentsError } from "./errors.js";
import type { IdempotencyKey } from "./idempotency.js";

export interface TrigenysPaymentsClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export interface MutationOptions {
  readonly idempotencyKey: IdempotencyKey;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: IdempotencyKey;
  readonly retrySafe?: boolean;
}

interface RequestAttempt {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: IdempotencyKey;
  readonly retrySafe: boolean;
}

export class TrigenysPaymentsClient {
  readonly payments: {
    create: (
      input: CreatePaymentRequest,
      options: MutationOptions
    ) => Promise<CreatePaymentResponse>;
    retrieve: (paymentId: string) => Promise<PaymentView>;
    verify: (paymentId: string) => Promise<VerifyPaymentResponse>;
  };

  readonly merchants: {
    create: (
      input: CreateMerchantRequest,
      options: MutationOptions
    ) => Promise<MerchantView>;
    retrieve: (merchantId: string) => Promise<MerchantView>;
  };

  readonly providerAccounts: {
    create: (
      merchantId: string,
      input: CreateProviderAccountRequest,
      options: MutationOptions
    ) => Promise<ProviderAccountView>;
    retrieve: (
      merchantId: string,
      providerAccountId: string
    ) => Promise<ProviderAccountView>;
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: TrigenysPaymentsClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new TypeError("baseUrl must not be empty.");
    }

    if (!options.apiKey.trim()) {
      throw new TypeError("apiKey must not be empty.");
    }

    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
    ) {
      throw new TypeError("maxRetries must be a non-negative integer.");
    }

    if (
      options.retryDelayMs !== undefined &&
      (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0)
    ) {
      throw new TypeError("retryDelayMs must be zero or greater.");
    }

    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;

    this.payments = {
      create: (input, mutation) =>
        this.request<CreatePaymentResponse>("POST", "/v1/payments", {
          body: input,
          idempotencyKey: mutation.idempotencyKey
        }),
      retrieve: (paymentId) =>
        this.request<PaymentView>(
          "GET",
          `/v1/payments/${encodeURIComponent(paymentId)}`,
          { retrySafe: true }
        ),
      verify: (paymentId) =>
        this.request<VerifyPaymentResponse>(
          "POST",
          `/v1/payments/${encodeURIComponent(paymentId)}/verify`,
          { retrySafe: true }
        )
    };

    this.merchants = {
      create: (input, mutation) =>
        this.request<MerchantView>("POST", "/v1/merchants", {
          body: input,
          idempotencyKey: mutation.idempotencyKey
        }),
      retrieve: (merchantId) =>
        this.request<MerchantView>(
          "GET",
          `/v1/merchants/${encodeURIComponent(merchantId)}`,
          { retrySafe: true }
        )
    };

    this.providerAccounts = {
      create: (merchantId, input, mutation) =>
        this.request<ProviderAccountView>(
          "POST",
          `/v1/merchants/${encodeURIComponent(merchantId)}/provider-accounts`,
          {
            body: input,
            idempotencyKey: mutation.idempotencyKey
          }
        ),
      retrieve: (merchantId, providerAccountId) =>
        this.request<ProviderAccountView>(
          "GET",
          `/v1/merchants/${encodeURIComponent(merchantId)}/provider-accounts/${encodeURIComponent(providerAccountId)}`,
          { retrySafe: true }
        )
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const attempt: RequestAttempt = {
      method,
      path,
      body: options.body,
      idempotencyKey: options.idempotencyKey,
      retrySafe:
        options.retrySafe === true ||
        method === "GET" ||
        Boolean(options.idempotencyKey)
    };

    let lastError: unknown;

    for (let index = 0; index <= this.maxRetries; index += 1) {
      try {
        return await this.execute<T>(attempt, index);
      } catch (error) {
        lastError = error;

        if (
          index >= this.maxRetries ||
          !attempt.retrySafe ||
          !this.shouldRetry(error)
        ) {
          throw error;
        }

        await this.delay(this.retryDelayMs * (index + 1));
      }
    }

    throw lastError;
  }

  private async execute<T>(
    attempt: RequestAttempt,
    attemptIndex: number
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${attempt.path}`, {
        method: attempt.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "@trigenys/payments/0.1.0",
          ...(attempt.idempotencyKey
            ? { "Idempotency-Key": attempt.idempotencyKey }
            : {})
        },
        body:
          attempt.body === undefined
            ? undefined
            : JSON.stringify(attempt.body)
      });
    } catch (error) {
      throw new TrigenysPaymentsError(
        "Payment Orchestrator could not be reached.",
        {
          code: "network_error",
          cause: error,
          details: {
            attempt: attemptIndex + 1
          }
        }
      );
    }

    const payload = await this.readJson(response);

    if (!response.ok) {
      const apiError = this.asApiError(payload);
      if (apiError) {
        throw TrigenysPaymentsError.fromApi(response.status, apiError.error);
      }

      throw new TrigenysPaymentsError(
        `Payment Orchestrator returned HTTP ${response.status}.`,
        {
          status: response.status,
          code: "http_error"
        }
      );
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !("data" in payload)
    ) {
      throw new TrigenysPaymentsError(
        "Payment Orchestrator returned an invalid success envelope.",
        {
          status: response.status,
          code: "invalid_response"
        }
      );
    }

    return (payload as ApiSuccess<T>).data;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new TrigenysPaymentsError(
        "Payment Orchestrator returned non-JSON content.",
        {
          status: response.status,
          code: "invalid_response",
          cause: error
        }
      );
    }
  }

  private asApiError(payload: unknown): ApiErrorResponse | undefined {
    if (
      !payload ||
      typeof payload !== "object" ||
      !("error" in payload)
    ) {
      return undefined;
    }

    const error = (payload as { error?: unknown }).error;
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !("message" in error) ||
      typeof (error as { code?: unknown }).code !== "string" ||
      typeof (error as { message?: unknown }).message !== "string"
    ) {
      return undefined;
    }

    return payload as ApiErrorResponse;
  }

  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof TrigenysPaymentsError)) {
      return false;
    }

    if (error.code === "network_error") {
      return true;
    }

    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500)
    );
  }

  private async delay(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
