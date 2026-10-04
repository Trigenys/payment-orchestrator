import type { ProviderCapabilityProfile } from "../capabilities.js";

export const cinetPayCapabilityProfile: ProviderCapabilityProfile = {
  provider: "cinetpay-v2",
  rules: [
    {
      capability: "collect",
      environments: ["live"],
      countries: ["CM"],
      currencies: ["XAF"]
    },
    {
      capability: "mobile_money",
      environments: ["live"],
      countries: ["CM"],
      currencies: ["XAF"]
    }
  ]
};
