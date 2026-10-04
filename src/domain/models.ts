import type { Money } from "./money.js";

export type ProjectStatus = "active" | "suspended";
export type MerchantStatus = "pending" | "active" | "restricted" | "disabled";
export type ProviderAccountStatus = "pending" | "active" | "restricted" | "disabled";
export type PaymentStatus =
  | "created"
  | "pending"
  | "authorized"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "partially_refunded"
  | "refunded";
export type RefundStatus = "pending" | "succeeded" | "failed";
export type SettlementStatus = "pending" | "in_transit" | "settled" | "failed" | "unknown";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
}

export interface Merchant {
  readonly id: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly country: string;
  readonly status: MerchantStatus;
  readonly createdAt: string;
}

export interface ProviderAccount {
  readonly id: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly environment: "sandbox" | "live";
  readonly externalAccountId: string;
  readonly status: ProviderAccountStatus;
  readonly createdAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface Payment {
  readonly id: string;
  readonly projectId: string;
  readonly merchantId: string;
  readonly providerAccountId?: string;
  readonly amount: Money;
  readonly status: PaymentStatus;
  readonly externalReference: string;
  readonly provider?: string;
  readonly providerEnvironment?: "sandbox" | "live";
  readonly providerReference?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface Refund {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly status: RefundStatus;
  readonly providerReference?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface Settlement {
  readonly id: string;
  readonly merchantId: string;
  readonly providerAccountId: string;
  readonly amount: Money;
  readonly status: SettlementStatus;
  readonly providerReference?: string;
  readonly expectedAt?: string;
  readonly settledAt?: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}
