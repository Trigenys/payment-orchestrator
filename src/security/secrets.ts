import type { ProviderEnvironment } from "../providers/capabilities.js";

export type SecretPurpose =
  | "provider_api"
  | "provider_webhook"
  | "project_api_pepper";

export type SecretStatus = "active" | "retiring" | "revoked";

export interface SecretReference {
  readonly id: string;
  readonly environment: ProviderEnvironment;
  readonly purpose: SecretPurpose;
  readonly version: number;
}

export interface SecretMaterial {
  readonly reference: SecretReference;
  readonly value: string;
  readonly status: SecretStatus;
  readonly activatedAt: string;
  readonly expiresAt?: string;
}

export interface SecretStore {
  get(reference: SecretReference): Promise<SecretMaterial | undefined>;
}

export interface ProviderCredentialBinding {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly purpose: Exclude<SecretPurpose, "project_api_pepper">;
  readonly secretReferences: readonly SecretReference[];
}

export type SecretResolutionErrorCode =
  | "ENVIRONMENT_MISMATCH"
  | "PURPOSE_MISMATCH"
  | "SECRET_NOT_FOUND"
  | "SECRET_REVOKED"
  | "NO_ACTIVE_SECRET";

export interface SecretResolutionError {
  readonly code: SecretResolutionErrorCode;
  readonly message: string;
  readonly referenceId?: string;
}

export type SecretResolutionResult =
  | { readonly ok: true; readonly secrets: readonly SecretMaterial[] }
  | { readonly ok: false; readonly error: SecretResolutionError };

export class ProviderCredentialResolver {
  constructor(private readonly store: SecretStore) {}

  async resolve(
    binding: ProviderCredentialBinding,
    environment: ProviderEnvironment
  ): Promise<SecretResolutionResult> {
    if (binding.environment !== environment) {
      return {
        ok: false,
        error: {
          code: "ENVIRONMENT_MISMATCH",
          message: `Credential binding environment "${binding.environment}" cannot be used for "${environment}".`
        }
      };
    }

    const resolved: SecretMaterial[] = [];

    for (const reference of binding.secretReferences) {
      if (reference.environment !== binding.environment) {
        return {
          ok: false,
          error: {
            code: "ENVIRONMENT_MISMATCH",
            message: "Secret reference environment does not match its provider credential binding.",
            referenceId: reference.id
          }
        };
      }

      if (reference.purpose !== binding.purpose) {
        return {
          ok: false,
          error: {
            code: "PURPOSE_MISMATCH",
            message: "Secret reference purpose does not match its provider credential binding.",
            referenceId: reference.id
          }
        };
      }

      const secret = await this.store.get(reference);
      if (!secret) {
        return {
          ok: false,
          error: {
            code: "SECRET_NOT_FOUND",
            message: "A configured secret reference could not be resolved.",
            referenceId: reference.id
          }
        };
      }

      if (secret.reference.environment !== environment) {
        return {
          ok: false,
          error: {
            code: "ENVIRONMENT_MISMATCH",
            message: "Resolved secret belongs to a different environment.",
            referenceId: reference.id
          }
        };
      }

      if (secret.status === "revoked") {
        continue;
      }

      resolved.push(secret);
    }

    if (resolved.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_ACTIVE_SECRET",
          message: "No active or retiring secret is available for this credential binding."
        }
      };
    }

    return {
      ok: true,
      secrets: resolved.sort((left, right) =>
        right.reference.version - left.reference.version
      )
    };
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, SecretMaterial>();

  constructor(initialSecrets: readonly SecretMaterial[] = []) {
    for (const secret of initialSecrets) {
      this.secrets.set(secret.reference.id, secret);
    }
  }

  async get(reference: SecretReference): Promise<SecretMaterial | undefined> {
    const secret = this.secrets.get(reference.id);
    if (!secret) return undefined;

    if (
      secret.reference.environment !== reference.environment ||
      secret.reference.purpose !== reference.purpose ||
      secret.reference.version !== reference.version
    ) {
      return undefined;
    }

    return secret;
  }
}
