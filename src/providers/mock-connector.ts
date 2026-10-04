import type { Money } from "../domain/money.js";
import type {
  Payment,
  ProviderAccount,
  Refund,
  Settlement
} from "../domain/models.js";
import {
  gateCapabilities,
  requiredCapabilitiesForPayment,
  type CreatePaymentInput,
  type CreateProviderAccountInput,
  type CreatePayoutInput,
  type CreateRefundInput,
  type GetSettlementInput,
  type Payout,
  type ProviderConnector,
  type ProviderOperationContext,
  type ProviderResult,
  type PaymentVerification,
  type VerifyPaymentInput
} from "./contracts.js";
import type { ProviderCapabilityProfile } from "./capabilities.js";

function now(): string {
  return new Date(0).toISOString();
}

function providerRef(kind: string, externalReference: string): string {
  return `mock:${kind}:${externalReference}`;
}

export class MockProviderConnector implements ProviderConnector {
  readonly provider: string;

  constructor(private readonly profile: ProviderCapabilityProfile) {
    this.provider = profile.provider;
  }

  getCapabilityProfile(): ProviderCapabilityProfile {
    return this.profile;
  }

  async createProviderAccount(
    input: CreateProviderAccountInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<ProviderAccount>> {
    const gate = gateCapabilities(this.profile, ["marketplace_accounts"], context);
    if (!gate.ok) return gate;

    return {
      ok: true,
      value: {
        id: `provider-account:${input.externalReference}`,
        merchantId: input.merchantId,
        provider: this.provider,
        environment: context.environment,
        externalAccountId: providerRef("account", input.externalReference),
        status: "active",
        createdAt: now()
      }
    };
  }

  async createPayment(
    input: CreatePaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payment>> {
    const gate = gateCapabilities(
      this.profile,
      requiredCapabilitiesForPayment(input),
      context
    );
    if (!gate.ok) return gate;

    return {
      ok: true,
      value: {
        id: `payment:${input.externalReference}`,
        projectId: input.projectId,
        merchantId: input.merchantId,
        providerAccountId: input.providerAccountId,
        amount: input.amount,
        status: "pending",
        externalReference: input.externalReference,
        providerReference: providerRef("payment", input.externalReference),
        version: 1,
        createdAt: now(),
        updatedAt: now()
      }
    };
  }

  async verifyPayment(
    input: VerifyPaymentInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<PaymentVerification>> {
    const gate = gateCapabilities(this.profile, ["collect"], context);
    if (!gate.ok) return gate;

    return {
      ok: true,
      value: {
        externalReference: input.externalReference,
        providerReference: providerRef("payment", input.externalReference),
        status: "succeeded",
        amount: {
          amountMinor: 0,
          currency: context.currency.toUpperCase()
        },
        verifiedAt: now()
      }
    };
  }

  async createRefund(
    input: CreateRefundInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Refund>> {
    const gate = gateCapabilities(this.profile, ["refunds"], context);
    if (!gate.ok) return gate;

    return {
      ok: true,
      value: {
        id: `refund:${input.externalReference}`,
        paymentId: input.payment.id,
        amount: input.amount,
        status: "pending",
        providerReference: providerRef("refund", input.externalReference),
        createdAt: now(),
        updatedAt: now()
      }
    };
  }

  async createPayout(
    input: CreatePayoutInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Payout>> {
    const gate = gateCapabilities(this.profile, ["payouts"], context);
    if (!gate.ok) return gate;

    return {
      ok: true,
      value: {
        id: `payout:${input.externalReference}`,
        merchantId: input.merchantId,
        providerAccountId: input.providerAccountId,
        amount: input.amount,
        status: "pending",
        providerReference: providerRef("payout", input.externalReference)
      }
    };
  }

  async getSettlement(
    input: GetSettlementInput,
    context: ProviderOperationContext
  ): Promise<ProviderResult<Settlement>> {
    const gate = gateCapabilities(this.profile, ["settlement_status"], context);
    if (!gate.ok) return gate;

    const amount: Money = {
      amountMinor: 0,
      currency: context.currency.toUpperCase()
    };

    return {
      ok: true,
      value: {
        id: `settlement:${input.providerReference}`,
        merchantId: input.merchantId,
        providerAccountId: input.providerAccountId,
        amount,
        status: "unknown",
        providerReference: input.providerReference
      }
    };
  }
}
