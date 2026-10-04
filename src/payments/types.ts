import type { Money } from "../domain/money.js";
import type { Payment, PaymentStatus } from "../domain/models.js";
import type { PaymentAllocation, PaymentChannel, ProviderError } from "../providers/contracts.js";
import type { ProviderEnvironment } from "../providers/capabilities.js";

export interface CreatePaymentCommand {
  readonly projectId: string;
  readonly merchantId: string;
  readonly providerAccountId?: string;
  readonly externalReference: string;
  readonly amount: Money;
  readonly channel: PaymentChannel;
  readonly allocations?: readonly PaymentAllocation[];
  readonly idempotencyKey: string;
}

export type PaymentCommandErrorCode =
  | "invalid_request"
  | "idempotency_conflict"
  | "payment_not_found"
  | "provider_reference_conflict"
  | "payment_already_bound"
  | "provider_event_conflict";

export interface PaymentCommandError {
  readonly code: PaymentCommandErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type PaymentCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PaymentCommandError };

export interface CreatePaymentSuccess {
  readonly payment: Payment;
  readonly replayed: boolean;
}

export interface BindProviderReferenceInput {
  readonly paymentId: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerPaymentReference: string;
}

export interface BindProviderReferenceSuccess {
  readonly payment: Payment;
  readonly replayed: boolean;
}

export interface NormalizedProviderPaymentEvent {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly eventId: string;
  readonly providerPaymentReference: string;
  readonly status: PaymentStatus;
  readonly occurredAt: string;
  readonly receivedAt?: string;
  readonly payloadDigest?: string;
}

export type ProviderEventOutcome =
  | "applied"
  | "ignored_duplicate_state"
  | "ignored_stale"
  | "rejected_invalid_transition"
  | "unmatched";

export interface ProviderEventReceipt {
  readonly key: string;
  readonly fingerprint: string;
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly eventId: string;
  readonly providerPaymentReference: string;
  readonly targetStatus: PaymentStatus;
  readonly outcome: ProviderEventOutcome;
  readonly paymentId?: string;
  readonly transitionId?: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly reason?: string;
}

export interface ProviderEventSuccess {
  readonly receipt: ProviderEventReceipt;
  readonly payment?: Payment;
  readonly replayed: boolean;
}

export interface PaymentTransitionEvidence {
  readonly id: string;
  readonly paymentId: string;
  readonly fromStatus: PaymentStatus | null;
  readonly toStatus: PaymentStatus;
  readonly source: "creation" | "provider_event";
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface PaymentCreationReservation {
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly paymentId: string;
  readonly createdAt: string;
}

export interface ProviderReferenceBinding {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerPaymentReference: string;
  readonly paymentId: string;
  readonly boundAt: string;
}

export interface PaymentAudit {
  readonly payment: Payment;
  readonly transitions: readonly PaymentTransitionEvidence[];
  readonly providerEvents: readonly ProviderEventReceipt[];
}

export type ProviderRetryDisposition =
  | "retry_same_operation"
  | "do_not_retry";

export function retryDisposition(error: ProviderError): ProviderRetryDisposition {
  return error.retryable ? "retry_same_operation" : "do_not_retry";
}
