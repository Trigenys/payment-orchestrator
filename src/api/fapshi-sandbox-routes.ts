import { createFapshiRoutes, type FapshiApiOptions } from "./fapshi-routes.js";

/** Legacy import and route paths remain sandbox-only. No duplicated handler. */
export type SandboxApiOptions = Omit<FapshiApiOptions, "environment">;
export function createFapshiSandboxRoutes(options: SandboxApiOptions) {
  return createFapshiRoutes({ ...options, environment: "sandbox" });
}
