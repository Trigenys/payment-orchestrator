import type { Payment } from "../domain/models.js";
import type { ProviderEnvironment } from "../providers/capabilities.js";
import type {
  PaymentCreationReservation,
  PaymentTransitionEvidence,
  ProviderEventReceipt,
  ProviderReferenceBinding
} from "./types.js";

export interface PaymentTransaction {
  getPayment(paymentId: string): Payment | undefined;
  putPayment(payment: Payment): void;

  getCreation(projectId: string, idempotencyKey: string): PaymentCreationReservation | undefined;
  putCreation(reservation: PaymentCreationReservation): void;

  getProviderBinding(
    provider: string,
    environment: ProviderEnvironment,
    providerPaymentReference: string
  ): ProviderReferenceBinding | undefined;
  putProviderBinding(binding: ProviderReferenceBinding): void;

  getProviderEvent(key: string): ProviderEventReceipt | undefined;
  putProviderEvent(receipt: ProviderEventReceipt): void;

  putTransition(transition: PaymentTransitionEvidence): void;
  listTransitions(paymentId: string): readonly PaymentTransitionEvidence[];
  listProviderEvents(paymentId: string): readonly ProviderEventReceipt[];
}

export interface PaymentPersistence {
  transaction<T>(
    work: (transaction: PaymentTransaction) => Promise<T> | T
  ): Promise<T>;
}

interface InMemoryState {
  payments: Map<string, Payment>;
  creations: Map<string, PaymentCreationReservation>;
  providerBindings: Map<string, ProviderReferenceBinding>;
  providerEvents: Map<string, ProviderEventReceipt>;
  transitions: Map<string, PaymentTransitionEvidence[]>;
}

function creationKey(projectId: string, idempotencyKey: string): string {
  return `${projectId}\u0000${idempotencyKey}`;
}

export function providerBindingKey(
  provider: string,
  environment: ProviderEnvironment,
  providerPaymentReference: string
): string {
  return [
    provider.trim().toLowerCase(),
    environment,
    providerPaymentReference.trim()
  ].join("\u0000");
}

export function providerEventKey(
  provider: string,
  environment: ProviderEnvironment,
  eventId: string
): string {
  return [
    provider.trim().toLowerCase(),
    environment,
    eventId.trim()
  ].join("\u0000");
}

function cloneState(state: InMemoryState): InMemoryState {
  return {
    payments: new Map(state.payments),
    creations: new Map(state.creations),
    providerBindings: new Map(state.providerBindings),
    providerEvents: new Map(state.providerEvents),
    transitions: new Map(
      [...state.transitions].map(([paymentId, transitions]) => [
        paymentId,
        [...transitions]
      ])
    )
  };
}

class InMemoryPaymentTransaction implements PaymentTransaction {
  constructor(private readonly state: InMemoryState) {}

  getPayment(paymentId: string): Payment | undefined {
    return this.state.payments.get(paymentId);
  }

  putPayment(payment: Payment): void {
    this.state.payments.set(payment.id, payment);
  }

  getCreation(projectId: string, idempotencyKey: string): PaymentCreationReservation | undefined {
    return this.state.creations.get(creationKey(projectId, idempotencyKey));
  }

  putCreation(reservation: PaymentCreationReservation): void {
    this.state.creations.set(
      creationKey(reservation.projectId, reservation.idempotencyKey),
      reservation
    );
  }

  getProviderBinding(
    provider: string,
    environment: ProviderEnvironment,
    providerPaymentReference: string
  ): ProviderReferenceBinding | undefined {
    return this.state.providerBindings.get(
      providerBindingKey(provider, environment, providerPaymentReference)
    );
  }

  putProviderBinding(binding: ProviderReferenceBinding): void {
    this.state.providerBindings.set(
      providerBindingKey(
        binding.provider,
        binding.environment,
        binding.providerPaymentReference
      ),
      binding
    );
  }

  getProviderEvent(key: string): ProviderEventReceipt | undefined {
    return this.state.providerEvents.get(key);
  }

  putProviderEvent(receipt: ProviderEventReceipt): void {
    this.state.providerEvents.set(receipt.key, receipt);
  }

  putTransition(transition: PaymentTransitionEvidence): void {
    const transitions = this.state.transitions.get(transition.paymentId) ?? [];
    if (transitions.some((existing) => existing.id === transition.id)) {
      return;
    }

    this.state.transitions.set(transition.paymentId, [...transitions, transition]);
  }

  listTransitions(paymentId: string): readonly PaymentTransitionEvidence[] {
    return [...(this.state.transitions.get(paymentId) ?? [])];
  }

  listProviderEvents(paymentId: string): readonly ProviderEventReceipt[] {
    return [...this.state.providerEvents.values()]
      .filter((receipt) => receipt.paymentId === paymentId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
}

export class InMemoryPaymentPersistence implements PaymentPersistence {
  private state: InMemoryState = {
    payments: new Map(),
    creations: new Map(),
    providerBindings: new Map(),
    providerEvents: new Map(),
    transitions: new Map()
  };

  private queue: Promise<void> = Promise.resolve();

  transaction<T>(
    work: (transaction: PaymentTransaction) => Promise<T> | T
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const draft = cloneState(this.state);
      const transaction = new InMemoryPaymentTransaction(draft);
      const result = await work(transaction);
      this.state = draft;
      return result;
    };

    const result = this.queue.then(execute, execute);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}
