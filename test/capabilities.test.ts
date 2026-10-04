import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCapability,
  type ProviderCapabilityProfile
} from "../src/providers/capabilities.js";

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
      capability: "split_payments",
      environments: ["sandbox"],
      countries: ["CM"],
      currencies: ["XAF"],
      requiresCommercialFeatures: ["marketplace-enabled"]
    }
  ]
};

test("capability rules match environment, country and currency", () => {
  const decision = evaluateCapability(profile, "collect", {
    environment: "sandbox",
    country: "cm",
    currency: "xaf"
  });

  assert.equal(decision.supported, true);
  assert.deepEqual(decision.failures, []);
});

test("commercial enablement is part of capability evaluation", () => {
  const blocked = evaluateCapability(profile, "split_payments", {
    environment: "sandbox",
    country: "CM",
    currency: "XAF"
  });

  assert.equal(blocked.supported, false);
  assert.ok(blocked.failures.some((failure) =>
    failure.code === "COMMERCIAL_FEATURE_REQUIRED"
  ));

  const enabled = evaluateCapability(profile, "split_payments", {
    environment: "sandbox",
    country: "CM",
    currency: "XAF",
    commercialFeatures: ["marketplace-enabled"]
  });

  assert.equal(enabled.supported, true);
});

test("undeclared capabilities fail closed", () => {
  const decision = evaluateCapability(profile, "refunds", {
    environment: "sandbox",
    country: "CM",
    currency: "XAF"
  });

  assert.equal(decision.supported, false);
  assert.equal(decision.failures[0]?.code, "CAPABILITY_NOT_DECLARED");
});

test("unsupported dimensions return actionable failure details", () => {
  const decision = evaluateCapability(profile, "collect", {
    environment: "live",
    country: "CI",
    currency: "USD"
  });

  assert.equal(decision.supported, false);
  assert.ok(decision.failures.some((failure) => failure.code === "ENVIRONMENT_UNSUPPORTED"));
  assert.ok(decision.failures.some((failure) => failure.code === "COUNTRY_UNSUPPORTED"));
  assert.ok(decision.failures.some((failure) => failure.code === "CURRENCY_UNSUPPORTED"));
});
