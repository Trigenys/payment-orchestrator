import { randomUUID } from "node:crypto";
import type { Payment, ProviderAccount, Refund, Settlement } from "../../domain/models.js";
import {
  gateCapabilities,
  requiredCapabilitiesForPayment,
  type CreatePaymentInput,
  type CreateProviderAccountInput,
  type CreatePayoutInput,
  type CreateRefundInput,
  type GetSettlementInput,
  type PaymentVerification,
  type Payout,
  type ProviderConnector,
  type ProviderOperationContext,
  type ProviderResult,
  type VerifyPaymentInput
} from "../contracts.js";
import { fapshiHostedCapabilityProfile } from "./capabilities.js";
import { FapshiHostedClient } from "./client.js";
import { mapFapshiStatus } from "./status.js";

export interface FapshiHostedConnectorOptions {
  readonly client: FapshiHostedClient;
  /** Bound service owner. A sandbox payment must not switch merchant/project. */
  readonly projectId: string;
  readonly merchantId: string;
  readonly providerAccountId?: string;
  /** Set after obtaining the actual Fapshi service label. */
  readonly expectedServiceName?: string;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function failure(
  code: "invalid_request" | "provider_rejected" | "authentication_failed" |
    "rate_limited" | "network_error" | "unknown",
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>
): ProviderResult<never> {
  return {
    ok: false,
    error: { code, provider: "fapshi", message, retryable, details }
  };
}

function safeReference(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function safeProviderTransactionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function safeHostedLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "fapshi.com" || url.hostname.endsWith(".fapshi.com"));
  } catch {
    return false;
  }
}

export class FapshiHostedConnector implements ProviderConnector {
  readonly provider = "fapshi";
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: FapshiHostedConnectorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  getCapabilityProfile() {
    return fapshiHostedCapabilityProfile;
  }

  async createProviderAccount(
    _input: CreateProviderAccountInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<ProviderAccount>> {
    const gate = gateCapabilities(
      fapshiHostedCapabilityProfile, ["marketplace_accounts"], context
    );
    if (!gate.ok) return gate;
    return failure("provider_rejected", "Fapshi marketplace accounts are not implemented.");
  }

  async createPayment(
    input: CreatePaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payment>> {
    const gate = gateCapabilities(
      fapshiHostedCapabilityProfile,
      requiredCapabilitiesForPayment(input), context
    );
    if (!gate.ok) return gate;

    if (
      input.projectId !== this.options.projectId ||
      context.projectId !== this.options.projectId ||
      input.merchantId !== this.options.merchantId ||
      (input.providerAccountId !== undefined &&
        input.providerAccountId !== this.options.providerAccountId)
    ) {
      return failure("invalid_request", "Payment identity is not authorized for this Fapshi service.");
    }
    if (input.channel !== "mobile_money" || input.allocations?.length) {
      return failure("invalid_request", "Fapshi pilot supports hosted mobile-money collection only.");
    }
    if (
      input.amount.currency.toUpperCase() !== "XAF" ||
      !Number.isSafeInteger(input.amount.amountMinor) ||
      input.amount.amountMinor < 100
    ) {
      return failure("invalid_request", "Fapshi amount must be an integer of at least 100 XAF.");
    }
    if (!safeReference(input.externalReference)) {
      return failure("invalid_request", "Fapshi externalId must contain 1–100 ASCII letters, digits, hyphens or underscores.");
    }
    if (!/^https:\/\//i.test(input.redirectUrl)) {
      return failure("invalid_request", "Redirect URL must use HTTPS.");
    }

    let response;
    try {
      response = await this.options.client.initiatePayment({
        amount: input.amount.amountMinor,
        externalId: input.externalReference,
        redirectUrl: input.redirectUrl,
        ...(input.customer.email ? { email: input.customer.email } : {})
      });
    } catch {
      // The PSP may have accepted a POST before the connection failed.
      // externalId is NOT a documented PSP idempotency key: never retry automatically.
      return failure("unknown", "Fapshi initiation outcome is ambiguous; reconcile manually before any new collection.");
    }

    if (response.status === 401 || response.status === 403) {
      return failure("authentication_failed", "Fapshi rejected sandbox credentials.");
    }
    if (response.status === 429) {
      return failure("rate_limited", "Fapshi initiation rate limited; outcome must be reconciled.", false);
    }
    if (response.status >= 500) {
      return failure("unknown", "Fapshi initiation outcome is ambiguous after a server error; do not retry.");
    }
    if (response.status !== 200) {
      return failure("provider_rejected", "Fapshi rejected checkout initialization.", false, {
        httpStatus: response.status
      });
    }

    const body = response.body;
    if (
      !body ||
      typeof body.transId !== "string" ||
      !safeProviderTransactionId(body.transId) ||
      typeof body.link !== "string" ||
      !safeHostedLink(body.link)
    ) {
      return failure("unknown", "Fapshi accepted initiation but returned an unusable checkout response. Reconcile; do not retry.");
    }

    const createdAt = this.now();
    return {
      ok: true,
      value: {
        id: this.newId(),
        projectId: input.projectId,
        merchantId: input.merchantId,
        providerAccountId: input.providerAccountId,
        externalReference: input.externalReference,
        providerReference: body.transId,
        provider: this.provider,
        providerEnvironment: context.environment,
        amount: input.amount,
        status: "pending",
        version: 1,
        createdAt,
        updatedAt: createdAt,
        providerMetadata: {
          checkoutUrl: body.link,
          bindingReferenceKind: "transId",
          linkExpiresAfterHours: 24,
          ...(body.dateInitiated ? { dateInitiated: body.dateInitiated } : {})
        }
      }
    };
  }

  /**
   * Fapshi-specific contract: input.externalReference is the PSP transId,
   * NOT the original order externalId. The persisted reference binding must
   * be looked up by the caller before verification. Do not credit from this
   * value without checking the original intent, amount and account.
   */
  async verifyPayment(
    input: VerifyPaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<PaymentVerification>> {
    const gate = gateCapabilities(fapshiHostedCapabilityProfile, ["collect"], context);
    if (!gate.ok) return gate;
    if (context.projectId !== this.options.projectId) {
      return failure("invalid_request", "Project is not authorized for this Fapshi service.");
    }
    if (!safeProviderTransactionId(input.externalReference)) {
      return failure("invalid_request", "Invalid Fapshi transaction reference.");
    }

    let response;
    try {
      response = await this.options.client.getStatus(input.externalReference);
    } catch {
      return failure("network_error", "Fapshi transaction status could not be read.", true);
    }
    if (response.status === 401 || response.status === 403) {
      return failure("authentication_failed", "Fapshi rejected status credentials.");
    }
    if (response.status === 429) {
      return failure("rate_limited", "Fapshi allows a maximum of six status requests per minute per transaction.", true);
    }
    if (response.status < 200 || response.status >= 300) {
      return failure("provider_rejected", "Fapshi status query was unsuccessful.", response.status >= 500);
    }

    const body = response.body;
    if (
      !body ||
      body.transId !== input.externalReference ||
      body.transType !== "Collection" ||
      typeof body.externalId !== "string" ||
      !safeReference(body.externalId) ||
      !Number.isSafeInteger(body.amount) ||
      (body.amount ?? 0) < 100 ||
      !Number.isSafeInteger(body.revenue) ||
      (body.revenue ?? -1) < 0 ||
      (body.revenue ?? Number.MAX_VALUE) > (body.amount ?? 0) ||
      (this.options.expectedServiceName !== undefined &&
        body.serviceName !== this.options.expectedServiceName)
    ) {
      return failure("provider_rejected", "Fapshi status contradicts the expected collection contract.");
    }

    let status;
    try {
      status = mapFapshiStatus(body.status ?? "");
    } catch {
      return failure("provider_rejected", "Fapshi returned an unrecognized transaction status.");
    }

    return {
      ok: true,
      value: {
        externalReference: body.externalId,
        providerReference: body.transId,
        status,
        amount: {
          amountMinor: body.amount!,
          currency: "XAF"
        },
        verifiedAt: this.now(),
        providerMetadata: {
          providerStatus: body.status,
          serviceName: body.serviceName,
          paymentMedium: body.medium,
          revenueMinor: body.revenue,
          feeMinor: body.amount! - body.revenue!,
          // FAILED is not accepted as terminal while attempt-level semantics are unknown.
          attemptMayBeRetried: body.status === "FAILED"
        }
      }
    };
  }

  async createRefund(
    _input: CreateRefundInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Refund>> {
    const gate = gateCapabilities(fapshiHostedCapabilityProfile, ["refunds"], context);
    if (!gate.ok) return gate;
    return failure("provider_rejected", "Refunds are not enabled for this pilot.");
  }

  async createPayout(
    _input: CreatePayoutInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payout>> {
    const gate = gateCapabilities(fapshiHostedCapabilityProfile, ["payouts"], context);
    if (!gate.ok) return gate;
    return failure("provider_rejected", "Payouts are not enabled for this pilot.");
  }

  async getSettlement(
    _input: GetSettlementInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Settlement>> {
    const gate = gateCapabilities(fapshiHostedCapabilityProfile, ["settlement_status"], context);
    if (!gate.ok) return gate;
    return failure("provider_rejected", "Settlement status is not enabled for this pilot.");
  }
}
