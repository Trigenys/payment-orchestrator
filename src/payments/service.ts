import { randomUUID } from "node:crypto";
import type { Payment } from "../domain/models.js";
import {
  paymentCreationFingerprint,
  providerEventFingerprint
} from "./fingerprint.js";
import {
  providerEventKey,
  type PaymentPersistence
} from "./persistence.js";
import { decidePaymentTransition } from "./state-machine.js";
import type {
  BindProviderReferenceInput,
  BindProviderReferenceSuccess,
  CreatePaymentCommand,
  CreatePaymentSuccess,
  NormalizedProviderPaymentEvent,
  PaymentAudit,
  PaymentCommandResult,
  PaymentTransitionEvidence,
  ProviderEventReceipt,
  ProviderEventSuccess
} from "./types.js";

export interface PaymentServiceDependencies {
  readonly persistence: PaymentPersistence;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function invalid(message: string): PaymentCommandResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message
    }
  };
}

function ensureNonEmpty(value: string, field: string): PaymentCommandResult<void> {
  if (!value.trim()) {
    return invalid(`${field} must not be empty.`);
  }

  return { ok: true, value: undefined };
}

export class PaymentService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly dependencies: PaymentServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.newId = dependencies.newId ?? randomUUID;
  }

  async createPayment(
    command: CreatePaymentCommand
  ): Promise<PaymentCommandResult<CreatePaymentSuccess>> {
    for (const [value, field] of [
      [command.projectId, "projectId"],
      [command.merchantId, "merchantId"],
      [command.externalReference, "externalReference"],
      [command.idempotencyKey, "idempotencyKey"]
    ] as const) {
      const validation = ensureNonEmpty(value, field);
      if (!validation.ok) return validation;
    }

    if (command.amount.amountMinor <= 0) {
      return invalid("Payment amount must be greater than zero.");
    }

    const fingerprint = paymentCreationFingerprint(command);

    return this.dependencies.persistence.transaction((transaction) => {
      const existing = transaction.getCreation(
        command.projectId,
        command.idempotencyKey
      );

      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            ok: false,
            error: {
              code: "idempotency_conflict",
              message: "The idempotency key was already used with a different payment request.",
              details: {
                projectId: command.projectId,
                idempotencyKey: command.idempotencyKey,
                paymentId: existing.paymentId
              }
            }
          };
        }

        const payment = transaction.getPayment(existing.paymentId);
        if (!payment) {
          throw new Error(
            `Invariant violation: payment "${existing.paymentId}" is missing for an idempotency reservation.`
          );
        }

        return {
          ok: true,
          value: {
            payment,
            replayed: true
          }
        };
      }

      const createdAt = this.now();
      const payment: Payment = {
        id: this.newId(),
        projectId: command.projectId,
        merchantId: command.merchantId,
        providerAccountId: command.providerAccountId,
        amount: command.amount,
        status: "created",
        externalReference: command.externalReference,
        version: 1,
        createdAt,
        updatedAt: createdAt
      };

      transaction.putPayment(payment);
      transaction.putCreation({
        projectId: command.projectId,
        idempotencyKey: command.idempotencyKey,
        fingerprint,
        paymentId: payment.id,
        createdAt
      });

      const transition: PaymentTransitionEvidence = {
        id: this.newId(),
        paymentId: payment.id,
        fromStatus: null,
        toStatus: "created",
        source: "creation",
        sourceId: `${command.projectId}:${command.idempotencyKey}`,
        occurredAt: createdAt,
        recordedAt: createdAt
      };
      transaction.putTransition(transition);

      return {
        ok: true,
        value: {
          payment,
          replayed: false
        }
      };
    });
  }

  async bindProviderReference(
    input: BindProviderReferenceInput
  ): Promise<PaymentCommandResult<BindProviderReferenceSuccess>> {
    for (const [value, field] of [
      [input.paymentId, "paymentId"],
      [input.provider, "provider"],
      [input.providerPaymentReference, "providerPaymentReference"]
    ] as const) {
      const validation = ensureNonEmpty(value, field);
      if (!validation.ok) return validation;
    }

    return this.dependencies.persistence.transaction((transaction) => {
      const payment = transaction.getPayment(input.paymentId);
      if (!payment) {
        return {
          ok: false,
          error: {
            code: "payment_not_found",
            message: `Payment "${input.paymentId}" was not found.`
          }
        };
      }

      const existingBinding = transaction.getProviderBinding(
        input.provider,
        input.environment,
        input.providerPaymentReference
      );

      if (existingBinding) {
        if (existingBinding.paymentId !== payment.id) {
          return {
            ok: false,
            error: {
              code: "provider_reference_conflict",
              message: "The provider reference is already bound to another payment.",
              details: {
                boundPaymentId: existingBinding.paymentId
              }
            }
          };
        }

        return {
          ok: true,
          value: {
            payment,
            replayed: true
          }
        };
      }

      if (
        payment.providerReference &&
        (
          payment.providerReference !== input.providerPaymentReference ||
          payment.provider !== input.provider ||
          payment.providerEnvironment !== input.environment
        )
      ) {
        return {
          ok: false,
          error: {
            code: "payment_already_bound",
            message: "The payment is already bound to a different provider reference."
          }
        };
      }

      const boundAt = this.now();
      const updated: Payment = {
        ...payment,
        provider: input.provider,
        providerEnvironment: input.environment,
        providerReference: input.providerPaymentReference,
        version: payment.version + 1,
        updatedAt: boundAt
      };

      transaction.putProviderBinding({
        provider: input.provider,
        environment: input.environment,
        providerPaymentReference: input.providerPaymentReference,
        paymentId: payment.id,
        boundAt
      });
      transaction.putPayment(updated);

      return {
        ok: true,
        value: {
          payment: updated,
          replayed: false
        }
      };
    });
  }

  async ingestProviderEvent(
    event: NormalizedProviderPaymentEvent
  ): Promise<PaymentCommandResult<ProviderEventSuccess>> {
    for (const [value, field] of [
      [event.provider, "provider"],
      [event.eventId, "eventId"],
      [event.providerPaymentReference, "providerPaymentReference"],
      [event.occurredAt, "occurredAt"]
    ] as const) {
      const validation = ensureNonEmpty(value, field);
      if (!validation.ok) return validation;
    }

    const key = providerEventKey(
      event.provider,
      event.environment,
      event.eventId
    );
    const fingerprint = providerEventFingerprint(event);
    const receivedAt = event.receivedAt ?? this.now();

    return this.dependencies.persistence.transaction((transaction) => {
      const existingReceipt = transaction.getProviderEvent(key);
      if (existingReceipt) {
        if (existingReceipt.fingerprint !== fingerprint) {
          return {
            ok: false,
            error: {
              code: "provider_event_conflict",
              message: "The provider event ID was already received with different normalized content.",
              details: {
                provider: event.provider,
                environment: event.environment,
                eventId: event.eventId
              }
            }
          };
        }

        return {
          ok: true,
          value: {
            receipt: existingReceipt,
            payment: existingReceipt.paymentId
              ? transaction.getPayment(existingReceipt.paymentId)
              : undefined,
            replayed: true
          }
        };
      }

      const binding = transaction.getProviderBinding(
        event.provider,
        event.environment,
        event.providerPaymentReference
      );

      if (!binding) {
        const receipt: ProviderEventReceipt = {
          key,
          fingerprint,
          provider: event.provider,
          environment: event.environment,
          eventId: event.eventId,
          providerPaymentReference: event.providerPaymentReference,
          targetStatus: event.status,
          outcome: "unmatched",
          occurredAt: event.occurredAt,
          receivedAt,
          reason: "No payment is bound to the provider reference."
        };
        transaction.putProviderEvent(receipt);

        return {
          ok: true,
          value: {
            receipt,
            replayed: false
          }
        };
      }

      const payment = transaction.getPayment(binding.paymentId);
      if (!payment) {
        throw new Error(
          `Invariant violation: payment "${binding.paymentId}" is missing for a provider reference binding.`
        );
      }

      const decision = decidePaymentTransition(payment.status, event.status);

      if (decision.outcome === "apply") {
        const updated: Payment = {
          ...payment,
          status: event.status,
          version: payment.version + 1,
          updatedAt: receivedAt
        };

        const transition: PaymentTransitionEvidence = {
          id: this.newId(),
          paymentId: payment.id,
          fromStatus: payment.status,
          toStatus: event.status,
          source: "provider_event",
          sourceId: key,
          occurredAt: event.occurredAt,
          recordedAt: receivedAt
        };

        const receipt: ProviderEventReceipt = {
          key,
          fingerprint,
          provider: event.provider,
          environment: event.environment,
          eventId: event.eventId,
          providerPaymentReference: event.providerPaymentReference,
          targetStatus: event.status,
          outcome: "applied",
          paymentId: payment.id,
          transitionId: transition.id,
          occurredAt: event.occurredAt,
          receivedAt
        };

        transaction.putPayment(updated);
        transaction.putTransition(transition);
        transaction.putProviderEvent(receipt);

        return {
          ok: true,
          value: {
            receipt,
            payment: updated,
            replayed: false
          }
        };
      }

      const outcome =
        decision.outcome === "ignore_duplicate"
          ? "ignored_duplicate_state"
          : decision.outcome === "ignore_stale"
            ? "ignored_stale"
            : "rejected_invalid_transition";

      const receipt: ProviderEventReceipt = {
        key,
        fingerprint,
        provider: event.provider,
        environment: event.environment,
        eventId: event.eventId,
        providerPaymentReference: event.providerPaymentReference,
        targetStatus: event.status,
        outcome,
        paymentId: payment.id,
        occurredAt: event.occurredAt,
        receivedAt,
        reason: decision.reason
      };
      transaction.putProviderEvent(receipt);

      return {
        ok: true,
        value: {
          receipt,
          payment,
          replayed: false
        }
      };
    });
  }

  async getPaymentAudit(
    paymentId: string
  ): Promise<PaymentCommandResult<PaymentAudit>> {
    return this.dependencies.persistence.transaction((transaction) => {
      const payment = transaction.getPayment(paymentId);
      if (!payment) {
        return {
          ok: false,
          error: {
            code: "payment_not_found",
            message: `Payment "${paymentId}" was not found.`
          }
        };
      }

      return {
        ok: true,
        value: {
          payment,
          transitions: transaction.listTransitions(paymentId),
          providerEvents: transaction.listProviderEvents(paymentId)
        }
      };
    });
  }
}
