import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { ProviderCapabilityProfile } from "../src/providers/capabilities.js";
import { MockProviderConnector } from "../src/providers/mock-connector.js";
import { runProviderContractSuite } from "./support/provider-contract.js";

const profile: ProviderCapabilityProfile = {
  provider: "mock-africa",
  rules: [
    {
      capability: "collect",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "mobile_money",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "marketplace_accounts",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "split_payments",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"],
      requiresCommercialFeatures: ["marketplace-enabled"]
    },
    {
      capability: "refunds",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "payouts",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "settlement_status",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"]
    }
  ]
};

runProviderContractSuite("MockProviderConnector", {
  createConnector: () => new MockProviderConnector(profile),
  supportedContext: {
    projectId: "project-1",
    environment: "sandbox",
    country: "CM",
    currency: "XAF",
    commercialFeatures: ["marketplace-enabled"]
  },
  unsupportedContext: {
    projectId: "project-1",
    environment: "live",
    country: "CM",
    currency: "XAF"
  }
});

test("core provider contracts contain no PSP-specific vocabulary", () => {
  const files = [
    "src/domain/models.ts",
    "src/providers/capabilities.ts",
    "src/providers/contracts.ts"
  ];

  const forbidden = [
    /flutterwave/i,
    /cinetpay/i,
    /notch\s*pay/i,
    /paystack/i,
    /subaccount/i
  ];

  for (const path of files) {
    const source = fs.readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} leaked provider-specific vocabulary`);
    }
  }
});
