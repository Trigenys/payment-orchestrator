import type { Money } from "../domain/money.js";
import type {
  Payment,
  Settlement
} from "../domain/models.js";
import type { LedgerEntryKind } from "../ledger/types.js";
import type { PaymentVerification } from "../providers/contracts.js";

export type ReconciliationStatus = "matched" | "discrepancy";

export type ReconciliationDiscrepancyType =
  | "amount_mismatch"
  | "currency_mismatch"
  | "status_mismatch"
  | "external_reference_mismatch"
  | "provider_reference_mismatch"
  | "ledger_component_missing"
  | "ledger_component_duplicate"
  | "ledger_component_mismatch"
  | "settlement_status_mismatch";

export interface ReconciliationDiscrepancy {
  readonly type: ReconciliationDiscrepancyType;
  readonly message: string;
  readonly component?: LedgerEntryKind;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ReconciliationRun {
  readonly id: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly merchantId: string;
  readonly subjectType: "payment" | "settlement";
  readonly subjectId: string;
  readonly provider: string;
  readonly providerReference?: string;
  readonly status: ReconciliationStatus;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  readonly createdAt: string;
}

export interface ReconciliationSuccess {
  readonly run: ReconciliationRun;
  readonly replayed: boolean;
}

export type ReconciliationErrorCode =
  | "invalid_request"
  | "scope_mismatch";

export interface ReconciliationError {
  readonly code: ReconciliationErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ReconciliationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ReconciliationError };

export interface AuthoritativePaymentFinancials {
  readonly providerFee?: Money;
  readonly merchantShare?: Money;
  readonly platformCommission?: Money;
}

export interface ReconcilePaymentInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly payment: Payment;
  readonly authoritative: PaymentVerification;
  readonly financials?: AuthoritativePaymentFinancials;
  readonly expectedProviderReference?: string;
}

export interface ReconcileSettlementInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly settlement: Settlement;
  readonly authoritative: Settlement;
}
