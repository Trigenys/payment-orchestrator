import type { Money } from "../domain/money.js";
import type { SettlementStatus } from "../domain/models.js";

export const LEDGER_ENTRY_KINDS = [
  "payment_gross",
  "provider_fee",
  "merchant_share",
  "platform_commission",
  "refund",
  "adjustment",
  "settlement_observed",
  "payout_observed"
] as const;

export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
export type AdjustmentDirection = "increase" | "decrease";

export interface LedgerEntry {
  readonly id: string;
  readonly batchId: string;
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly settlementId?: string;
  readonly sourceKey: string;
  readonly kind: LedgerEntryKind;
  readonly amount: Money;
  readonly adjustmentDirection?: AdjustmentDirection;
  readonly settlementStatus?: SettlementStatus;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LedgerBatch {
  readonly id: string;
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly settlementId?: string;
  readonly sourceKey: string;
  readonly fingerprint: string;
  readonly entryIds: readonly string[];
  readonly recordedAt: string;
}

export interface LedgerScope {
  readonly projectId: string;
  readonly merchantId?: string;
  readonly paymentId?: string;
}

export type LedgerErrorCode =
  | "invalid_request"
  | "ledger_conflict";

export interface LedgerError {
  readonly code: LedgerErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type LedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LedgerError };

export interface AppendLedgerSuccess {
  readonly batch: LedgerBatch;
  readonly entries: readonly LedgerEntry[];
  readonly replayed: boolean;
}

export interface RecordPaymentBreakdownInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly sourceKey: string;
  readonly gross: Money;
  readonly providerFee?: Money;
  readonly merchantShare?: Money;
  readonly platformCommission?: Money;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecordRefundInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly sourceKey: string;
  readonly amount: Money;
  readonly provider?: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecordAdjustmentInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly sourceKey: string;
  readonly amount: Money;
  readonly direction: AdjustmentDirection;
  readonly reason: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ObserveSettlementInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly settlementId: string;
  readonly sourceKey: string;
  readonly amount: Money;
  readonly status: SettlementStatus;
  readonly provider: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}


export interface ObservePayoutInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly sourceKey: string;
  readonly amount: Money;
  readonly provider: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
