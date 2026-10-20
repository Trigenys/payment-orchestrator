import type { ProviderEnvironment } from "../capabilities.js";

/** Deliberately no arbitrary base URL: credentials only go to the selected PSP. */
const endpoints = {
  sandbox: "https://sandbox.fapshi.com",
  live: "https://live.fapshi.com"
} as const;

export function parseFapshiEnvironment(value: unknown): ProviderEnvironment {
  if (value !== "sandbox" && value !== "live") {
    throw new Error("Fapshi environment must be sandbox or live.");
  }
  return value;
}

export function fapshiBaseUrl(environment: ProviderEnvironment): string {
  return endpoints[parseFapshiEnvironment(environment)];
}
