import { randomUUID } from "node:crypto";
import type {
  Payment,
  ProviderAccount,
  Refund,
  Settlement
} from "../../domain/models.js";
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
import { cinetPayCapabilityProfile } from "./capabilities.js";
import { CinetPayCheckoutClient } from "./client.js";
import { mapCinetPayPaymentStatus } from "./status.js";

export interface CinetPayConnectorOptions {
  readonly client: CinetPayCheckoutClient;
  readonly notifyUrl: string;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function providerError(
  message: string,
  code: "invalid_request" | "authentication_failed" | "provider_rejected" | "network_error" = "provider_rejected",
  retryable = false,
  details?: Readonly<Record<string, unknown>>
): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      provider: "cinetpay-v2",
      message,
      retryable,
      details
    }
  };
}

function normalizedCode(value: string): string {
  return value.trim().toUpperCase();
}

function safeDescription(reference: string): string {
  const cleaned = reference
    .replace(/[#/$&_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? `Payment ${cleaned}` : "Payment";
}

function parseXafAmount(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

export class CinetPayV2Connector implements ProviderConnector {
  readonly provider = "cinetpay-v2";

  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: CinetPayConnectorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  getCapabilityProfile() {
    return cinetPayCapabilityProfile;
  }

  async createProviderAccount(
    _input: CreateProviderAccountInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<ProviderAccount>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      ["marketplace_accounts"],
      context
    );
    if (!gate.ok) return gate;

    return providerError(
      "CinetPay Marque Blanche merchant onboarding is not implemented without partner/private API documentation."
    );
  }

  async createPayment(
    input: CreatePaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payment>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      requiredCapabilitiesForPayment(input),
      context
    );
    if (!gate.ok) return gate;

    if (input.channel !== "mobile_money") {
      return providerError(
        "CinetPay public connector foundation currently supports MOBILE_MONEY only.",
        "invalid_request"
      );
    }

    if (input.allocations?.length) {
      return providerError(
        "CinetPay public Checkout must not be used as if it were Marque Blanche split settlement.",
        "invalid_request"
      );
    }

    if (
      normalizedCode(context.country) !== "CM" ||
      normalizedCode(input.amount.currency) !== "XAF"
    ) {
      return providerError(
        "This connector foundation is limited to Cameroon/XAF.",
        "invalid_request"
      );
    }

    if (
      input.amount.amountMinor < 100 ||
      input.amount.amountMinor > 1_500_000
    ) {
      return providerError(
        "CinetPay Cameroon XAF amount must be between 100 and 1,500,000.",
        "invalid_request"
      );
    }

    if (input.amount.amountMinor % 5 !== 0) {
      return providerError(
        "CinetPay Checkout requires non-USD amounts to be multiples of 5.",
        "invalid_request"
      );
    }

    let response;
    try {
      response = await this.options.client.initializePayment({
        transaction_id: input.externalReference,
        amount: input.amount.amountMinor,
        currency: "XAF",
        description: safeDescription(input.externalReference),
        notify_url: this.options.notifyUrl,
        return_url: input.redirectUrl,
        channels: "MOBILE_MONEY",
        metadata: input.externalReference,
        customer_name: input.customer.name,
        customer_email: input.customer.email,
        customer_phone_number: input.customer.phone
      });
    } catch (error) {
      return providerError(
        "CinetPay payment initialization failed before a response was received.",
        "network_error",
        true,
        { cause: error instanceof Error ? error.message : "unknown" }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return providerError(
        "CinetPay rejected the connector credentials or service configuration.",
        "authentication_failed"
      );
    }

    if (
      response.status === 429 ||
      response.body.code === "429"
    ) {
      return {
        ok: false,
        error: {
          code: "rate_limited",
          provider: this.provider,
          message: response.body.message || "CinetPay rate limited the request.",
          retryable: true,
          details: { httpStatus: response.status }
        }
      };
    }

    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.code !== "201" ||
      !response.body.data?.payment_url ||
      !response.body.data.payment_token
    ) {
      return providerError(
        response.body.description ||
          response.body.message ||
          "CinetPay rejected payment initialization.",
        "provider_rejected",
        response.status >= 500,
        {
          httpStatus: response.status,
          providerCode: response.body.code
        }
      );
    }

    const createdAt = this.now();

    return {
      ok: true,
      value: {
        id: this.newId(),
        projectId: input.projectId,
        merchantId: input.merchantId,
        amount: input.amount,
        status: "pending",
        externalReference: input.externalReference,
        provider: this.provider,
        providerEnvironment: context.environment,
        providerReference: input.externalReference,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        providerMetadata: {
          checkoutUrl: response.body.data.payment_url,
          paymentToken: response.body.data.payment_token,
          apiResponseId: response.body.api_response_id,
          bindingReferenceKind: "transaction_id"
        }
      }
    };
  }

  async verifyPayment(
    input: VerifyPaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<PaymentVerification>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      ["collect"],
      context
    );
    if (!gate.ok) return gate;

    let response;
    try {
      response = await this.options.client.verifyPayment(
        input.externalReference
      );
    } catch (error) {
      return providerError(
        "CinetPay verification failed before a response was received.",
        "network_error",
        true,
        { cause: error instanceof Error ? error.message : "unknown" }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return providerError(
        "CinetPay rejected the connector credentials or service configuration.",
        "authentication_failed"
      );
    }

    if (
      response.status < 200 ||
      response.status >= 300 ||
      !response.body.data
    ) {
      return providerError(
        response.body.message || "CinetPay transaction verification failed.",
        "provider_rejected",
        response.status >= 500,
        {
          httpStatus: response.status,
          providerCode: response.body.code
        }
      );
    }

    const amountMinor = parseXafAmount(response.body.data.amount);
    if (amountMinor === undefined) {
      return providerError(
        "CinetPay returned a non-integer amount for an XAF transaction."
      );
    }

    let status;
    try {
      status = mapCinetPayPaymentStatus(response.body.data.status);
    } catch (error) {
      return providerError(
        error instanceof Error
          ? error.message
          : "Unsupported CinetPay payment status."
      );
    }

    return {
      ok: true,
      value: {
        externalReference: input.externalReference,
        providerReference: input.externalReference,
        status,
        amount: {
          amountMinor,
          currency: normalizedCode(response.body.data.currency)
        },
        verifiedAt: this.now(),
        providerMetadata: {
          providerCode: response.body.code,
          providerMessage: response.body.message,
          paymentMethod: response.body.data.payment_method,
          operatorId: response.body.data.operator_id,
          paymentDate: response.body.data.payment_date,
          fundAvailabilityDate:
            response.body.data.fund_availability_date,
          apiResponseId: response.body.api_response_id
        }
      }
    };
  }

  async createRefund(
    _input: CreateRefundInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Refund>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      ["refunds"],
      context
    );
    if (!gate.ok) return gate;

    return providerError(
      "CinetPay refund support is not part of the public connector foundation."
    );
  }

  async createPayout(
    _input: CreatePayoutInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payout>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      ["payouts"],
      context
    );
    if (!gate.ok) return gate;

    return providerError(
      "CinetPay payout/reversal support requires a separate validated contract."
    );
  }

  async getSettlement(
    _input: GetSettlementInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Settlement>> {
    const gate = gateCapabilities(
      cinetPayCapabilityProfile,
      ["settlement_status"],
      context
    );
    if (!gate.ok) return gate;

    return providerError(
      "CinetPay settlement status is not implemented in the public connector foundation."
    );
  }
}
