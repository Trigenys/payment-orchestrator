import type { ProviderCapabilityProfile } from "../capabilities.js";

// Hosted collection uses the same protocol in both environments. Runtime
// configuration and service credentials decide which environment is enabled.
export const fapshiHostedCapabilityProfile: ProviderCapabilityProfile = {
  provider: "fapshi",
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
    }
  ]
};
