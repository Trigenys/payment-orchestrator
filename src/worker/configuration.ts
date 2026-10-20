import type { ProviderEnvironment } from "../providers/capabilities.js";
import { parseFapshiEnvironment } from "../providers/fapshi/environment.js";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface InboxRuntimeConfig {
  readonly environment: ProviderEnvironment;
  readonly projectId: string;
  readonly merchantId: string;
  readonly serviceName: string;
  readonly apiuser: string;
  readonly apikey: string;
}

/** Older sandbox-only installations retain their safe default. No live inference. */
export function paymentEnvironment(env: RuntimeEnvironment): ProviderEnvironment {
  return parseFapshiEnvironment(env.PAYMENT_ENVIRONMENT ?? "sandbox");
}

export function runtimeEnabled(
  env: RuntimeEnvironment, flag: string, legacySandboxFlag: string
): boolean {
  if (env[flag] !== undefined) return env[flag] === "true";
  return paymentEnvironment(env) === "sandbox" && env[legacySandboxFlag] === "true";
}

export function requiredRuntimeValue(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Payment runtime requires ${name}.`);
  return value;
}

export function readInboxRuntimeConfig(env: RuntimeEnvironment): InboxRuntimeConfig {
  const environment = paymentEnvironment(env);
  const suffix = environment.toUpperCase();
  const required = (name: string) => requiredRuntimeValue(env, name);
  return {
    environment,
    projectId: required(`PAYMENT_${suffix}_PROJECT_ID`),
    merchantId: required(`PAYMENT_${suffix}_MERCHANT_ID`),
    serviceName: required(`FAPSHI_${suffix}_SERVICE_NAME`),
    apiuser: required(`FAPSHI_${suffix}_APIUSER`),
    apikey: required(`FAPSHI_${suffix}_APIKEY`)
  };
}

export function runtimeDatabaseUrl(env: RuntimeEnvironment): string {
  const environment = paymentEnvironment(env);
  const name = `PAYMENT_${environment.toUpperCase()}_DATABASE_URL`;
  // DATABASE_URL was the original sandbox entrypoint. Never use it for live.
  if (environment === "sandbox" && env[name] === undefined) {
    return requiredRuntimeValue(env, "DATABASE_URL");
  }
  return requiredRuntimeValue(env, name);
}

export function runtimeSecret(env: RuntimeEnvironment, suffix: "WEBHOOK_SECRET" | "INTERNAL_TOKEN"): string {
  const environment = paymentEnvironment(env);
  const prefix = suffix === "WEBHOOK_SECRET" ? "FAPSHI" : "PAYMENT";
  return requiredRuntimeValue(env, `${prefix}_${environment.toUpperCase()}_${suffix}`);
}
