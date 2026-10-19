import type { ProviderCapabilityProfile } from "../capabilities.js";

// Documented hosted collection only. Live is intentionally disabled until
// Trigenys's actual Fapshi service entitlement is verified in #23.
export const fapshiHostedCapabilityProfile: ProviderCapabilityProfile = {
  provider: "fapshi",
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
    }
  ]
};
