import type { Money } from "../domain/money.js";
import type {
  Payment,
  ProviderAccount,
  Refund,
  Settlement
} from "../domain/models.js";
import {
  evaluateCapabilities,
  type CapabilityContext,
  type ProviderCapability,
  type ProviderCapabilityProfile
} from "./capabilities.js";

export type ProviderErrorCode =
  | "capability_unsupported"
  | "invalid_request"
  | "authentication_failed"
  | "provider_rejected"
  | "rate_limited"
  | "network_error"
  | "unknown";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderError };

export interface ProviderOperationContext extends CapabilityContext {
  readonly projectId: string;
}

export type PaymentChannel = "mobile_money" | "card" | "bank_transfer" | "other";

export interface PaymentAllocation {
  readonly providerAccountId: string;
  readonly amount: Money;
}

export type SettlementDestination =
  | {
      readonly type: "bank_account";
      readonly country: string;
      readonly currency: string;
      readonly bankCode: string;
      readonly accountNumber: string;
      readonly accountName?: string;
    }
  | {
      readonly type: "mobile_money";
      readonly country: string;
      readonly currency: string;
      readonly network: string;
      readonly phoneNumber: string;
      readonly accountName?: string;
    };

export interface PaymentCustomer {
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
}

export interface ProviderAccountContact {
  readonly email?: string;
  readonly phone?: string;
}

export interface CreateProviderAccountInput {
  readonly merchantId: string;
  readonly displayName: string;
  readonly country: string;
  readonly currency: string;
  readonly externalReference: string;
  readonly settlementDestination: SettlementDestination;
  readonly contact?: ProviderAccountContact;
}

export interface CreatePaymentInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly providerAccountId?: string;
  readonly externalReference: string;
  readonly amount: Money;
  readonly channel: PaymentChannel;
  readonly customer: PaymentCustomer;
  readonly redirectUrl: string;
  readonly allocations?: readonly PaymentAllocation[];
}

export interface VerifyPaymentInput {
  readonly externalReference: string;
}

export interface PaymentVerification {
  readonly externalReference: string;
  readonly providerReference: string;
  readonly status: Payment["status"];
  readonly amount: Money;
  readonly verifiedAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface CreateRefundInput {
  readonly payment: Payment;
  readonly amount: Money;
  readonly externalReference: string;
}

export interface CreatePayoutInput {
  readonly merchantId: string;
  readonly providerAccountId: string;
  readonly amount: Money;
  readonly externalReference: string;
}

export interface Payout {
  readonly id: string;
  readonly merchantId: string;
  readonly providerAccountId: string;
  readonly amount: Money;
  readonly status: "pending" | "succeeded" | "failed";
  readonly providerReference?: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface GetSettlementInput {
  readonly merchantId: string;
  readonly providerAccountId: string;
  readonly providerReference: string;
}

export interface ProviderConnector {
  readonly provider: string;

  getCapabilityProfile(): ProviderCapabilityProfile;

  createProviderAccount(
    input: CreateProviderAccountInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<ProviderAccount>>;

  createPayment(
    input: CreatePaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payment>>;

  verifyPayment(
    input: VerifyPaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<PaymentVerification>>;

  createRefund(
    input: CreateRefundInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Refund>>;

  createPayout(
    input: CreatePayoutInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payout>>;

  getSettlement(
    input: GetSettlementInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Settlement>>;
}

export function requiredCapabilitiesForPayment(
  input: CreatePaymentInput
): readonly ProviderCapability[] {
  const capabilities: ProviderCapability[] = ["collect"];

  if (input.channel === "mobile_money") {
    capabilities.push("mobile_money");
  }

  if (input.allocations?.length) {
    capabilities.push("split_payments");
  }

  return capabilities;
}

export function gateCapabilities(
  profile: ProviderCapabilityProfile,
  capabilities: readonly ProviderCapability[],
  context: CapabilityContext
): ProviderResult<void> {
  const decisions = evaluateCapabilities(profile, capabilities, context);
  const rejected = decisions.filter((decision) => !decision.supported);

  if (rejected.length === 0) {
    return { ok: true, value: undefined };
  }

  return {
    ok: false,
    error: {
      code: "capability_unsupported",
      provider: profile.provider,
      message: `Provider "${profile.provider}" does not support the requested operation in this context.`,
      retryable: false,
      details: {
        rejected
      }
    }
  };
}
