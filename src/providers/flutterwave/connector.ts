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
import type { ProviderHttpClient } from "../http.js";
import {
  flutterwaveCapabilityProfile
} from "./capabilities.js";
import { mapFlutterwavePaymentStatus } from "./status.js";
import type {
  FlutterwaveCollectionSubaccount,
  FlutterwaveEnvelope,
  FlutterwaveHostedPaymentLink,
  FlutterwaveVerifiedTransaction
} from "./types.js";

const API_BASE = "https://api.flutterwave.com/v3";

export interface FlutterwaveProviderAccountResolver {
  getById(providerAccountId: string): Promise<ProviderAccount | undefined>;
}

export interface FlutterwaveConnectorOptions {
  readonly httpClient: ProviderHttpClient;
  readonly getSecretKey: () => Promise<string>;
  readonly providerAccounts: FlutterwaveProviderAccountResolver;
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
      provider: "flutterwave-v3",
      message,
      retryable,
      details
    }
  };
}

function envelopeMessage(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message?: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }

  return undefined;
}

function normalizedCode(value: string): string {
  return value.trim().toUpperCase();
}

function paymentOption(channel: CreatePaymentInput["channel"]): string | undefined {
  if (channel === "mobile_money") return "mobilemoneyxaf";
  if (channel === "card") return "card";
  return undefined;
}

export class FlutterwaveV3Connector implements ProviderConnector {
  readonly provider = "flutterwave-v3";

  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: FlutterwaveConnectorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  getCapabilityProfile() {
    return flutterwaveCapabilityProfile;
  }

  async createProviderAccount(
    input: CreateProviderAccountInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<ProviderAccount>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      ["marketplace_accounts"],
      context
    );
    if (!gate.ok) return gate;

    if (input.settlementDestination.type !== "bank_account") {
      return providerError(
        "Flutterwave collection subaccounts are bank-account settlement destinations in the documented v3 split-payment flow.",
        "invalid_request"
      );
    }

    if (!input.contact?.phone?.trim()) {
      return providerError(
        "Flutterwave collection subaccount creation requires a business mobile number.",
        "invalid_request"
      );
    }

    if (
      normalizedCode(input.country) !== normalizedCode(context.country) ||
      normalizedCode(input.currency) !== normalizedCode(context.currency) ||
      normalizedCode(input.settlementDestination.country) !== normalizedCode(context.country) ||
      normalizedCode(input.settlementDestination.currency) !== normalizedCode(context.currency)
    ) {
      return providerError(
        "Provider-account country/currency must match the operation context.",
        "invalid_request"
      );
    }

    const secretKey = await this.options.getSecretKey();

    let response;
    try {
      response = await this.options.httpClient.request<
        FlutterwaveEnvelope<FlutterwaveCollectionSubaccount>
      >({
        method: "POST",
        url: `${API_BASE}/subaccounts`,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: {
          account_bank: input.settlementDestination.bankCode,
          account_number: input.settlementDestination.accountNumber,
          business_name: input.displayName,
          business_mobile: input.contact.phone,
          business_email: input.contact.email,
          country: normalizedCode(input.country),
          split_type: "percentage",
          split_value: 0
        }
      });
    } catch (error) {
      return providerError(
        "Flutterwave subaccount request failed before a response was received.",
        "network_error",
        true,
        { cause: error instanceof Error ? error.message : "unknown" }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return providerError(
        "Flutterwave rejected the connector credentials.",
        "authentication_failed"
      );
    }

    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.status !== "success" ||
      !response.body.data?.subaccount_id
    ) {
      return providerError(
        envelopeMessage(response.body) ?? "Flutterwave rejected collection subaccount creation.",
        "provider_rejected",
        response.status >= 500,
        { httpStatus: response.status }
      );
    }

    const createdAt = this.now();

    return {
      ok: true,
      value: {
        id: this.newId(),
        merchantId: input.merchantId,
        provider: this.provider,
        environment: context.environment,
        externalAccountId: response.body.data.subaccount_id,
        status: "active",
        createdAt,
        providerMetadata: {
          numericId: response.body.data.id,
          bankName: response.body.data.bank_name,
          country: response.body.data.country
        }
      }
    };
  }

  async createPayment(
    input: CreatePaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payment>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      requiredCapabilitiesForPayment(input),
      context
    );
    if (!gate.ok) return gate;

    if (input.channel !== "mobile_money" && input.channel !== "card") {
      return providerError(
        `Flutterwave Cameroon foundation supports hosted card or mobile-money collection, not channel "${input.channel}".`,
        "invalid_request"
      );
    }

    if (!input.customer.email.trim() || !input.redirectUrl.trim()) {
      return providerError(
        "Flutterwave Standard requires customer email and redirectUrl.",
        "invalid_request"
      );
    }

    let subaccounts:
      | readonly Readonly<Record<string, string | number>>[]
      | undefined;

    if (input.allocations?.length) {
      if (input.allocations.length !== 1) {
        return providerError(
          "Flutterwave Cameroon marketplace POC currently supports one beneficiary per payment.",
          "invalid_request"
        );
      }

      const allocation = input.allocations[0]!;
      const providerAccount = await this.options.providerAccounts.getById(
        allocation.providerAccountId
      );

      if (
        !providerAccount ||
        providerAccount.provider !== this.provider ||
        providerAccount.environment !== context.environment
      ) {
        return providerError(
          "The payment allocation does not resolve to an active Flutterwave provider account in this environment.",
          "invalid_request"
        );
      }

      if (
        normalizedCode(allocation.amount.currency) !== normalizedCode(input.amount.currency)
      ) {
        return providerError(
          "Payment allocation currency must match payment currency.",
          "invalid_request"
        );
      }

      const commissionMinor =
        input.amount.amountMinor - allocation.amount.amountMinor;

      if (commissionMinor < 0) {
        return providerError(
          "Payment allocation cannot exceed the gross payment amount.",
          "invalid_request"
        );
      }

      subaccounts = [{
        id: providerAccount.externalAccountId,
        transaction_charge_type: "flat",
        transaction_charge: commissionMinor
      }];
    }

    const secretKey = await this.options.getSecretKey();

    let response;
    try {
      response = await this.options.httpClient.request<
        FlutterwaveEnvelope<FlutterwaveHostedPaymentLink>
      >({
        method: "POST",
        url: `${API_BASE}/payments`,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: {
          tx_ref: input.externalReference,
          amount: input.amount.amountMinor,
          currency: normalizedCode(input.amount.currency),
          redirect_url: input.redirectUrl,
          customer: {
            email: input.customer.email,
            name: input.customer.name,
            phonenumber: input.customer.phone
          },
          payment_options: paymentOption(input.channel),
          subaccounts,
          meta: {
            trigenys_project_id: input.projectId,
            trigenys_merchant_id: input.merchantId
          }
        }
      });
    } catch (error) {
      return providerError(
        "Flutterwave payment-link request failed before a response was received.",
        "network_error",
        true,
        { cause: error instanceof Error ? error.message : "unknown" }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return providerError(
        "Flutterwave rejected the connector credentials.",
        "authentication_failed"
      );
    }

    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.status !== "success" ||
      !response.body.data?.link
    ) {
      return providerError(
        envelopeMessage(response.body) ?? "Flutterwave rejected payment creation.",
        "provider_rejected",
        response.status >= 500,
        { httpStatus: response.status }
      );
    }

    const createdAt = this.now();

    return {
      ok: true,
      value: {
        id: this.newId(),
        projectId: input.projectId,
        merchantId: input.merchantId,
        providerAccountId:
          input.providerAccountId ?? input.allocations?.[0]?.providerAccountId,
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
          checkoutUrl: response.body.data.link,
          bindingReferenceKind: "tx_ref"
        }
      }
    };
  }

  async verifyPayment(
    input: VerifyPaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<PaymentVerification>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      ["collect"],
      context
    );
    if (!gate.ok) return gate;

    const secretKey = await this.options.getSecretKey();
    const url = new URL(`${API_BASE}/transactions/verify_by_reference`);
    url.searchParams.set("tx_ref", input.externalReference);

    let response;
    try {
      response = await this.options.httpClient.request<
        FlutterwaveEnvelope<FlutterwaveVerifiedTransaction>
      >({
        method: "GET",
        url: url.toString(),
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      });
    } catch (error) {
      return providerError(
        "Flutterwave verification request failed before a response was received.",
        "network_error",
        true,
        { cause: error instanceof Error ? error.message : "unknown" }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return providerError(
        "Flutterwave rejected the connector credentials.",
        "authentication_failed"
      );
    }

    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.status !== "success" ||
      !response.body.data
    ) {
      return providerError(
        envelopeMessage(response.body) ?? "Flutterwave could not verify the transaction.",
        "provider_rejected",
        response.status >= 500,
        { httpStatus: response.status }
      );
    }

    let status;
    try {
      status = mapFlutterwavePaymentStatus(response.body.data.status);
    } catch (error) {
      return providerError(
        error instanceof Error ? error.message : "Unsupported Flutterwave payment status.",
        "provider_rejected"
      );
    }

    return {
      ok: true,
      value: {
        externalReference: response.body.data.tx_ref,
        providerReference: response.body.data.flw_ref,
        status,
        amount: {
          amountMinor: response.body.data.amount,
          currency: normalizedCode(response.body.data.currency)
        },
        verifiedAt: this.now(),
        providerMetadata: {
          transactionId: response.body.data.id,
          paymentType: response.body.data.payment_type,
          appFee: response.body.data.app_fee,
          merchantFee: response.body.data.merchant_fee,
          amountSettled: response.body.data.amount_settled
        }
      }
    };
  }

  async createRefund(
    _input: CreateRefundInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Refund>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      ["refunds"],
      context
    );
    if (!gate.ok) return gate;

    return providerError("Flutterwave refunds are not implemented in this connector foundation.");
  }

  async createPayout(
    _input: CreatePayoutInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payout>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      ["payouts"],
      context
    );
    if (!gate.ok) return gate;

    return providerError("Flutterwave payouts are not implemented in this connector foundation.");
  }

  async getSettlement(
    _input: GetSettlementInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Settlement>> {
    const gate = gateCapabilities(
      flutterwaveCapabilityProfile,
      ["settlement_status"],
      context
    );
    if (!gate.ok) return gate;

    return providerError("Flutterwave settlement queries are not implemented in this connector foundation.");
  }
}
