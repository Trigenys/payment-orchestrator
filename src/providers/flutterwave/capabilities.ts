import type { ProviderCapabilityProfile } from "../capabilities.js";

export const FLUTTERWAVE_CM_MARKETPLACE_APPROVED =
  "flutterwave.cm-marketplace-approved";

export const flutterwaveCapabilityProfile: ProviderCapabilityProfile = {
  provider: "flutterwave-v3",
  rules: [
    {
      capability: "collect",
      environments: ["sandbox", "live"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "mobile_money",
      environments: ["sandbox", "live"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "marketplace_accounts",
      environments: ["sandbox", "live"],
      countries: ["CM"],
      currencies: ["XAF"],
      requiresCommercialFeatures: [FLUTTERWAVE_CM_MARKETPLACE_APPROVED]
    },
    {
      capability: "split_payments",
      environments: ["sandbox", "live"],
      countries: ["CM"],
      currencies: ["XAF"],
      requiresCommercialFeatures: [FLUTTERWAVE_CM_MARKETPLACE_APPROVED]
    }
  ]
};
