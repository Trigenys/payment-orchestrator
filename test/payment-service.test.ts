import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import { InMemoryPaymentPersistence } from "../src/payments/persistence.js";
import { PaymentService } from "../src/payments/service.js";

function serviceFixture() {
  let nextId = 0;
  let tick = 0;

  return new PaymentService({
    persistence: new InMemoryPaymentPersistence(),
    newId: () => `id-${++nextId}`,
    now: () => new Date(Date.UTC(2026, 9, 4, 15, 0, tick++)).toISOString()
  });
}

function paymentCommand(idempotencyKey = "idem-1") {
  return {
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    externalReference: "zamari-payment-1",
    amount: createMoney(50_000, "XAF"),
    channel: "mobile_money" as const,
    idempotencyKey
  };
}

test("duplicate create requests return the same logical payment", async () => {
  const service = serviceFixture();

  const first = await service.createPayment(paymentCommand());
  const second = await service.createPayment(paymentCommand());

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.value.replayed, false);
  assert.equal(second.value.replayed, true);
  assert.equal(first.value.payment.id, second.value.payment.id);
  assert.equal(second.value.payment.version, 1);

  const audit = await service.getPaymentAudit(first.value.payment.id);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;

  assert.equal(audit.value.transitions.length, 1);
  assert.equal(audit.value.transitions[0]?.fromStatus, null);
  assert.equal(audit.value.transitions[0]?.toStatus, "created");
});

test("same idempotency key with a different request fails explicitly", async () => {
  const service = serviceFixture();

  await service.createPayment(paymentCommand());

  const conflict = await service.createPayment({
    ...paymentCommand(),
    amount: createMoney(60_000, "XAF")
  });

  assert.equal(conflict.ok, false);
  if (conflict.ok) return;

  assert.equal(conflict.error.code, "idempotency_conflict");
});

test("concurrent duplicate create requests reserve only one payment", async () => {
  const service = serviceFixture();

  const results = await Promise.all(
    Array.from({ length: 20 }, () => service.createPayment(paymentCommand("concurrent-1")))
  );

  assert.ok(results.every((result) => result.ok));
  const successful = results.filter((result) => result.ok);
  if (successful.length !== results.length) return;

  const ids = new Set(successful.map((result) => result.value.payment.id));
  assert.equal(ids.size, 1);
  assert.equal(successful.filter((result) => !result.value.replayed).length, 1);
  assert.equal(successful.filter((result) => result.value.replayed).length, 19);
});

test("provider references are unique and binding is idempotent", async () => {
  const service = serviceFixture();
  const first = await service.createPayment(paymentCommand("bind-1"));
  const second = await service.createPayment({
    ...paymentCommand("bind-2"),
    externalReference: "zamari-payment-2"
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  const binding = {
    paymentId: first.value.payment.id,
    provider: "provider-a",
    environment: "sandbox" as const,
    providerPaymentReference: "provider-payment-1"
  };

  const bound = await service.bindProviderReference(binding);
  const replay = await service.bindProviderReference(binding);

  assert.equal(bound.ok, true);
  assert.equal(replay.ok, true);
  if (!bound.ok || !replay.ok) return;

  assert.equal(bound.value.replayed, false);
  assert.equal(replay.value.replayed, true);

  const conflict = await service.bindProviderReference({
    ...binding,
    paymentId: second.value.payment.id
  });

  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "provider_reference_conflict");
});

test("duplicate provider callbacks are replay-safe under concurrency", async () => {
  const service = serviceFixture();
  const created = await service.createPayment(paymentCommand("event-1"));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const bound = await service.bindProviderReference({
    paymentId: created.value.payment.id,
    provider: "provider-a",
    environment: "sandbox",
    providerPaymentReference: "provider-payment-1"
  });
  assert.equal(bound.ok, true);

  const event = {
    provider: "provider-a",
    environment: "sandbox" as const,
    eventId: "event-succeeded-1",
    providerPaymentReference: "provider-payment-1",
    status: "succeeded" as const,
    occurredAt: "2026-10-04T15:05:00.000Z"
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () => service.ingestProviderEvent(event))
  );

  assert.ok(results.every((result) => result.ok));
  const successful = results.filter((result) => result.ok);
  if (successful.length !== results.length) return;

  assert.equal(successful.filter((result) => !result.value.replayed).length, 1);
  assert.equal(successful.filter((result) => result.value.replayed).length, 19);
  assert.ok(successful.every((result) => result.value.receipt.outcome === "applied"));

  const audit = await service.getPaymentAudit(created.value.payment.id);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;

  assert.equal(audit.value.payment.status, "succeeded");
  assert.equal(audit.value.transitions.length, 2);
  assert.equal(audit.value.providerEvents.length, 1);
});

test("out-of-order callbacks are retained but cannot regress state", async () => {
  const service = serviceFixture();
  const created = await service.createPayment(paymentCommand("out-of-order"));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await service.bindProviderReference({
    paymentId: created.value.payment.id,
    provider: "provider-a",
    environment: "sandbox",
    providerPaymentReference: "provider-payment-out-of-order"
  });

  const succeeded = await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "event-2",
    providerPaymentReference: "provider-payment-out-of-order",
    status: "succeeded",
    occurredAt: "2026-10-04T15:10:00.000Z"
  });
  assert.equal(succeeded.ok, true);

  const latePending = await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "event-1",
    providerPaymentReference: "provider-payment-out-of-order",
    status: "pending",
    occurredAt: "2026-10-04T15:00:00.000Z"
  });
  assert.equal(latePending.ok, true);
  if (!latePending.ok) return;

  assert.equal(latePending.value.receipt.outcome, "ignored_stale");
  assert.equal(latePending.value.payment?.status, "succeeded");

  const audit = await service.getPaymentAudit(created.value.payment.id);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;

  assert.equal(audit.value.payment.status, "succeeded");
  assert.equal(audit.value.providerEvents.length, 2);
  assert.equal(audit.value.transitions.length, 2);
});

test("impossible transitions are rejected without corrupting state", async () => {
  const service = serviceFixture();
  const created = await service.createPayment(paymentCommand("invalid-transition"));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await service.bindProviderReference({
    paymentId: created.value.payment.id,
    provider: "provider-a",
    environment: "sandbox",
    providerPaymentReference: "provider-payment-terminal"
  });

  await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "failed-event",
    providerPaymentReference: "provider-payment-terminal",
    status: "failed",
    occurredAt: "2026-10-04T15:00:00.000Z"
  });

  const contradictory = await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "success-after-failure",
    providerPaymentReference: "provider-payment-terminal",
    status: "succeeded",
    occurredAt: "2026-10-04T15:01:00.000Z"
  });

  assert.equal(contradictory.ok, true);
  if (!contradictory.ok) return;

  assert.equal(
    contradictory.value.receipt.outcome,
    "rejected_invalid_transition"
  );
  assert.equal(contradictory.value.payment?.status, "failed");

  const audit = await service.getPaymentAudit(created.value.payment.id);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;

  assert.equal(audit.value.payment.status, "failed");
  assert.equal(audit.value.providerEvents.length, 2);
  assert.equal(audit.value.transitions.length, 2);
});

test("same provider event ID with different normalized content conflicts", async () => {
  const service = serviceFixture();
  const created = await service.createPayment(paymentCommand("event-conflict"));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await service.bindProviderReference({
    paymentId: created.value.payment.id,
    provider: "provider-a",
    environment: "sandbox",
    providerPaymentReference: "provider-payment-conflict"
  });

  await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "provider-event-1",
    providerPaymentReference: "provider-payment-conflict",
    status: "pending",
    occurredAt: "2026-10-04T15:00:00.000Z"
  });

  const conflict = await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "provider-event-1",
    providerPaymentReference: "provider-payment-conflict",
    status: "succeeded",
    occurredAt: "2026-10-04T15:00:00.000Z"
  });

  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "provider_event_conflict");
});

test("unmatched callbacks are retained for reconciliation", async () => {
  const service = serviceFixture();

  const result = await service.ingestProviderEvent({
    provider: "provider-a",
    environment: "sandbox",
    eventId: "unmatched-event",
    providerPaymentReference: "unknown-reference",
    status: "succeeded",
    occurredAt: "2026-10-04T15:00:00.000Z"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.receipt.outcome, "unmatched");
  assert.equal(result.value.payment, undefined);
});
