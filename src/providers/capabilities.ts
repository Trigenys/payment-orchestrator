export const PROVIDER_CAPABILITIES = [
  "collect",
  "mobile_money",
  "refunds",
  "payouts",
  "marketplace_accounts",
  "split_payments",
  "settlement_status"
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];
export type ProviderEnvironment = "sandbox" | "live";

export interface CapabilityContext {
  readonly environment: ProviderEnvironment;
  readonly country: string;
  readonly currency: string;
  readonly commercialFeatures?: readonly string[];
}

export interface CapabilityRule {
  readonly capability: ProviderCapability;
  readonly environments?: readonly ProviderEnvironment[];
  readonly countries?: readonly string[];
  readonly currencies?: readonly string[];
  readonly requiresCommercialFeatures?: readonly string[];
}

export interface ProviderCapabilityProfile {
  readonly provider: string;
  readonly rules: readonly CapabilityRule[];
}

export type CapabilityFailureCode =
  | "CAPABILITY_NOT_DECLARED"
  | "ENVIRONMENT_UNSUPPORTED"
  | "COUNTRY_UNSUPPORTED"
  | "CURRENCY_UNSUPPORTED"
  | "COMMERCIAL_FEATURE_REQUIRED";

export interface CapabilityFailure {
  readonly code: CapabilityFailureCode;
  readonly message: string;
  readonly required?: readonly string[];
  readonly actual?: string;
}

export interface CapabilityDecision {
  readonly provider: string;
  readonly capability: ProviderCapability;
  readonly context: CapabilityContext;
  readonly supported: boolean;
  readonly failures: readonly CapabilityFailure[];
}

function normalizedCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeList(values: readonly string[] | undefined): readonly string[] | undefined {
  return values?.map(normalizedCode);
}

function evaluateRule(rule: CapabilityRule, context: CapabilityContext): readonly CapabilityFailure[] {
  const failures: CapabilityFailure[] = [];
  const country = normalizedCode(context.country);
  const currency = normalizedCode(context.currency);

  if (rule.environments && !rule.environments.includes(context.environment)) {
    failures.push({
      code: "ENVIRONMENT_UNSUPPORTED",
      message: `Capability is not enabled in environment "${context.environment}".`,
      required: rule.environments,
      actual: context.environment
    });
  }

  const countries = normalizeList(rule.countries);
  if (countries && !countries.includes(country)) {
    failures.push({
      code: "COUNTRY_UNSUPPORTED",
      message: `Capability is not enabled for country "${country}".`,
      required: countries,
      actual: country
    });
  }

  const currencies = normalizeList(rule.currencies);
  if (currencies && !currencies.includes(currency)) {
    failures.push({
      code: "CURRENCY_UNSUPPORTED",
      message: `Capability is not enabled for currency "${currency}".`,
      required: currencies,
      actual: currency
    });
  }

  if (rule.requiresCommercialFeatures?.length) {
    const enabled = new Set(context.commercialFeatures ?? []);
    const missing = rule.requiresCommercialFeatures.filter((feature) => !enabled.has(feature));

    if (missing.length) {
      failures.push({
        code: "COMMERCIAL_FEATURE_REQUIRED",
        message: `Capability requires commercial feature(s): ${missing.join(", ")}.`,
        required: missing
      });
    }
  }

  return failures;
}

export function evaluateCapability(
  profile: ProviderCapabilityProfile,
  capability: ProviderCapability,
  context: CapabilityContext
): CapabilityDecision {
  const rules = profile.rules.filter((rule) => rule.capability === capability);

  if (rules.length === 0) {
    return {
      provider: profile.provider,
      capability,
      context,
      supported: false,
      failures: [{
        code: "CAPABILITY_NOT_DECLARED",
        message: `Provider "${profile.provider}" does not declare capability "${capability}".`
      }]
    };
  }

  const attempts = rules.map((rule) => evaluateRule(rule, context));
  if (attempts.some((failures) => failures.length === 0)) {
    return {
      provider: profile.provider,
      capability,
      context,
      supported: true,
      failures: []
    };
  }

  const deduplicated = new Map<string, CapabilityFailure>();
  for (const failures of attempts) {
    for (const failure of failures) {
      const key = JSON.stringify([failure.code, failure.actual, failure.required]);
      if (!deduplicated.has(key)) {
        deduplicated.set(key, failure);
      }
    }
  }

  return {
    provider: profile.provider,
    capability,
    context,
    supported: false,
    failures: [...deduplicated.values()]
  };
}

export function evaluateCapabilities(
  profile: ProviderCapabilityProfile,
  capabilities: readonly ProviderCapability[],
  context: CapabilityContext
): readonly CapabilityDecision[] {
  return capabilities.map((capability) => evaluateCapability(profile, capability, context));
}
