import type { ProviderEnvironment } from "../providers/capabilities.js";
import type {
  NormalizedProviderPaymentEvent,
  PaymentCommandResult,
  ProviderEventSuccess
} from "../payments/types.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  ProviderCredentialResolver,
  type ProviderCredentialBinding,
  type SecretMaterial
} from "./secrets.js";

export interface RawWebhookRequest {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: string;
  readonly sourceIp?: string;
}

export type WebhookVerificationFailureCode =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_INVALID"
  | "TIMESTAMP_INVALID"
  | "MALFORMED_REQUEST";

export type WebhookVerificationResult =
  | {
      readonly ok: true;
      readonly matchedSecretReferenceId: string;
      readonly verificationMetadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: WebhookVerificationFailureCode;
        readonly message: string;
      };
    };

export interface ProviderWebhookAdapter {
  readonly provider: string;

  verify(
    request: RawWebhookRequest,
    secrets: readonly SecretMaterial[]
  ): Promise<WebhookVerificationResult>;

  normalize(
    request: RawWebhookRequest,
    verification: Extract<WebhookVerificationResult, { readonly ok: true }>
  ): Promise<NormalizedProviderPaymentEvent>;
}

export interface WebhookCredentialRegistry {
  get(
    provider: string,
    environment: ProviderEnvironment
  ): ProviderCredentialBinding | undefined;
}

export interface PaymentEventSink {
  ingestProviderEvent(
    event: NormalizedProviderPaymentEvent
  ): Promise<PaymentCommandResult<ProviderEventSuccess>>;
}

export type WebhookIngressErrorCode =
  | "PROVIDER_MISMATCH"
  | "BODY_TOO_LARGE"
  | "RATE_LIMITED"
  | "CREDENTIAL_BINDING_NOT_FOUND"
  | "CREDENTIAL_RESOLUTION_FAILED"
  | "INVALID_SIGNATURE"
  | "ADAPTER_CONTRACT_VIOLATION"
  | "DOMAIN_REJECTED";

export type WebhookIngressResult =
  | {
      readonly ok: true;
      readonly value: ProviderEventSuccess;
      readonly matchedSecretReferenceId: string;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: WebhookIngressErrorCode;
        readonly message: string;
        readonly retryAfterMs?: number;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

export interface WebhookIngressDependencies {
  readonly adapter: ProviderWebhookAdapter;
  readonly credentialRegistry: WebhookCredentialRegistry;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly paymentEventSink: PaymentEventSink;
  readonly rateLimiter?: RateLimiter;
  readonly maxBodyBytes?: number;
}

export class WebhookIngressService {
  constructor(private readonly dependencies: WebhookIngressDependencies) {}

  async ingest(request: RawWebhookRequest): Promise<WebhookIngressResult> {
    const maxBodyBytes = this.dependencies.maxBodyBytes ?? 1_048_576;
    if (request.rawBody.byteLength > maxBodyBytes) {
      return {
        ok: false,
        error: {
          code: "BODY_TOO_LARGE",
          message: "Webhook body exceeds the configured size limit."
        }
      };
    }

    const expectedProvider = this.dependencies.adapter.provider
      .trim()
      .toLowerCase();
    const requestProvider = request.provider.trim().toLowerCase();

    if (expectedProvider !== requestProvider) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_MISMATCH",
          message: "Webhook request was routed to the wrong provider adapter."
        }
      };
    }

    const rateLimitKey = [
      requestProvider,
      request.environment,
      request.sourceIp ?? "unknown-source"
    ].join(":");

    if (this.dependencies.rateLimiter) {
      const rateLimit = this.dependencies.rateLimiter.consume(rateLimitKey);

      if (!rateLimit.allowed) {
        return {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Webhook ingress rate limit exceeded.",
            retryAfterMs: rateLimit.retryAfterMs
          }
        };
      }
    }

    const binding = this.dependencies.credentialRegistry.get(
      requestProvider,
      request.environment
    );

    if (!binding) {
      return {
        ok: false,
        error: {
          code: "CREDENTIAL_BINDING_NOT_FOUND",
          message: "No webhook credential binding is configured for this provider/environment."
        }
      };
    }

    const resolved = await this.dependencies.credentialResolver.resolve(
      binding,
      request.environment
    );

    if (!resolved.ok) {
      return {
        ok: false,
        error: {
          code: "CREDENTIAL_RESOLUTION_FAILED",
          message: "Webhook verification credentials are unavailable.",
          details: {
            reason: resolved.error.code,
            referenceId: resolved.error.referenceId
          }
        }
      };
    }

    const verification = await this.dependencies.adapter.verify(
      request,
      resolved.secrets
    );

    if (!verification.ok) {
      return {
        ok: false,
        error: {
          code: "INVALID_SIGNATURE",
          message: "Webhook authenticity could not be verified.",
          details: {
            reason: verification.error.code
          }
        }
      };
    }

    const normalized = await this.dependencies.adapter.normalize(
      request,
      verification
    );

    if (
      normalized.provider.trim().toLowerCase() !== requestProvider ||
      normalized.environment !== request.environment
    ) {
      return {
        ok: false,
        error: {
          code: "ADAPTER_CONTRACT_VIOLATION",
          message: "Verified webhook normalized to a different provider/environment."
        }
      };
    }

    const domainResult = await this.dependencies.paymentEventSink.ingestProviderEvent({
      ...normalized,
      receivedAt: normalized.receivedAt ?? request.receivedAt
    });

    if (!domainResult.ok) {
      return {
        ok: false,
        error: {
          code: "DOMAIN_REJECTED",
          message: "Verified webhook was rejected by the payment domain.",
          details: {
            domainCode: domainResult.error.code
          }
        }
      };
    }

    return {
      ok: true,
      value: domainResult.value,
      matchedSecretReferenceId: verification.matchedSecretReferenceId
    };
  }
}

export class InMemoryWebhookCredentialRegistry implements WebhookCredentialRegistry {
  private readonly bindings = new Map<string, ProviderCredentialBinding>();

  constructor(bindings: readonly ProviderCredentialBinding[] = []) {
    for (const binding of bindings) {
      this.bindings.set(
        this.key(binding.provider, binding.environment),
        binding
      );
    }
  }

  get(
    provider: string,
    environment: ProviderEnvironment
  ): ProviderCredentialBinding | undefined {
    return this.bindings.get(this.key(provider, environment));
  }

  private key(provider: string, environment: ProviderEnvironment): string {
    return `${provider.trim().toLowerCase()}:${environment}`;
  }
}
