import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../../src/domain/money.js";
import type { ProviderConnector, ProviderOperationContext } from "../../src/providers/contracts.js";

export interface ProviderContractFixture {
  readonly createConnector: () => ProviderConnector;
  readonly supportedContext: ProviderOperationContext;
  readonly unsupportedContext: ProviderOperationContext;
}

export function runProviderContractSuite(
  name: string,
  fixture: ProviderContractFixture
): void {
  test(`${name}: declared collection capability succeeds in supported context`, async () => {
    const connector = fixture.createConnector();

    const result = await connector.createPayment({
      projectId: fixture.supportedContext.projectId,
      merchantId: "merchant-1",
      externalReference: "payment-1",
      amount: createMoney(10_000, fixture.supportedContext.currency),
      channel: "other",
      customer: { email: "buyer@example.com" },
      redirectUrl: "https://example.com/payment-return"
    }, fixture.supportedContext);

    assert.equal(result.ok, true);
  });

  test(`${name}: unsupported context fails closed with capability error`, async () => {
    const connector = fixture.createConnector();

    const result = await connector.createPayment({
      projectId: fixture.unsupportedContext.projectId,
      merchantId: "merchant-1",
      externalReference: "payment-2",
      amount: createMoney(10_000, fixture.unsupportedContext.currency),
      channel: "other",
      customer: { email: "buyer@example.com" },
      redirectUrl: "https://example.com/payment-return"
    }, fixture.unsupportedContext);

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.equal(result.error.code, "capability_unsupported");
    assert.equal(result.error.retryable, false);
    assert.match(result.error.message, /does not support the requested operation/i);
    assert.ok(result.error.details);
  });

  test(`${name}: mobile money requires both collect and mobile_money`, async () => {
    const connector = fixture.createConnector();

    const result = await connector.createPayment({
      projectId: fixture.supportedContext.projectId,
      merchantId: "merchant-1",
      externalReference: "payment-3",
      amount: createMoney(10_000, fixture.supportedContext.currency),
      channel: "mobile_money",
      customer: { email: "buyer@example.com" },
      redirectUrl: "https://example.com/payment-return"
    }, fixture.supportedContext);

    assert.equal(result.ok, true);
  });

  test(`${name}: verification is part of the provider contract`, async () => {
    const connector = fixture.createConnector();

    const result = await connector.verifyPayment({
      externalReference: "payment-1"
    }, fixture.supportedContext);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.externalReference, "payment-1");
  });

  test(`${name}: marketplace account operation is capability-gated`, async () => {
    const connector = fixture.createConnector();

    const result = await connector.createProviderAccount({
      merchantId: "merchant-1",
      displayName: "Merchant One",
      country: fixture.supportedContext.country,
      currency: fixture.supportedContext.currency,
      externalReference: "merchant-1",
      settlementDestination: {
        type: "bank_account",
        country: fixture.supportedContext.country,
        currency: fixture.supportedContext.currency,
        bankCode: "TESTBANK",
        accountNumber: "0000000001"
      }
    }, fixture.supportedContext);

    assert.equal(result.ok, true);
  });
}
