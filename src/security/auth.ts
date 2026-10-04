import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import type { ProviderEnvironment } from "../providers/capabilities.js";

export const PROJECT_SCOPES = [
  "payments:create",
  "payments:read",
  "merchants:write",
  "settlements:read"
] as const;

export type ProjectScope = (typeof PROJECT_SCOPES)[number];

export interface ProjectCredentialRecord {
  readonly credentialId: string;
  readonly projectId: string;
  readonly environment: ProviderEnvironment;
  readonly secretDigest: string;
  readonly scopes: readonly ProjectScope[];
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ProjectCredentialStore {
  getById(credentialId: string): Promise<ProjectCredentialRecord | undefined>;
}

export interface ProjectPrincipal {
  readonly credentialId: string;
  readonly projectId: string;
  readonly environment: ProviderEnvironment;
  readonly scopes: readonly ProjectScope[];
}

export type AuthenticationFailureCode =
  | "MALFORMED_API_KEY"
  | "CREDENTIAL_NOT_FOUND"
  | "CREDENTIAL_REVOKED"
  | "INVALID_API_KEY"
  | "ENVIRONMENT_MISMATCH";

export type AuthenticationResult =
  | { readonly ok: true; readonly principal: ProjectPrincipal }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: AuthenticationFailureCode;
        readonly message: string;
      };
    };

export type AuthorizationFailureCode =
  | "PROJECT_MISMATCH"
  | "ENVIRONMENT_MISMATCH"
  | "SCOPE_MISSING";

export type AuthorizationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: AuthorizationFailureCode;
        readonly message: string;
        readonly missingScopes?: readonly ProjectScope[];
      };
    };

export function projectApiSecretDigest(secret: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(secret)
    .digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

interface ParsedApiKey {
  readonly environment: ProviderEnvironment;
  readonly credentialId: string;
  readonly secret: string;
}

function parseProjectApiKey(apiKey: string): ParsedApiKey | undefined {
  const match = /^po_(test|live)_([A-Za-z0-9-]+)\.([A-Za-z0-9_-]{16,})$/.exec(apiKey);
  if (!match) return undefined;

  return {
    environment: match[1] === "test" ? "sandbox" : "live",
    credentialId: match[2]!,
    secret: match[3]!
  };
}

export class ProjectApiKeyAuthenticator {
  constructor(
    private readonly store: ProjectCredentialStore,
    private readonly pepper: string
  ) {
    if (!pepper) {
      throw new Error("Project API key pepper must not be empty.");
    }
  }

  async authenticate(apiKey: string): Promise<AuthenticationResult> {
    const parsed = parseProjectApiKey(apiKey);
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_API_KEY",
          message: "Project API key format is invalid."
        }
      };
    }

    const record = await this.store.getById(parsed.credentialId);
    if (!record) {
      return {
        ok: false,
        error: {
          code: "CREDENTIAL_NOT_FOUND",
          message: "Project credential was not found."
        }
      };
    }

    if (record.revokedAt) {
      return {
        ok: false,
        error: {
          code: "CREDENTIAL_REVOKED",
          message: "Project credential has been revoked."
        }
      };
    }

    if (record.environment !== parsed.environment) {
      return {
        ok: false,
        error: {
          code: "ENVIRONMENT_MISMATCH",
          message: "API key environment does not match the credential environment."
        }
      };
    }

    const digest = projectApiSecretDigest(parsed.secret, this.pepper);
    if (!safeEqualHex(digest, record.secretDigest)) {
      return {
        ok: false,
        error: {
          code: "INVALID_API_KEY",
          message: "Project API key is invalid."
        }
      };
    }

    return {
      ok: true,
      principal: {
        credentialId: record.credentialId,
        projectId: record.projectId,
        environment: record.environment,
        scopes: record.scopes
      }
    };
  }
}

export function authorizeProject(
  principal: ProjectPrincipal,
  input: {
    readonly projectId: string;
    readonly environment: ProviderEnvironment;
    readonly requiredScopes: readonly ProjectScope[];
  }
): AuthorizationResult {
  if (principal.projectId !== input.projectId) {
    return {
      ok: false,
      error: {
        code: "PROJECT_MISMATCH",
        message: "Credential is not authorized for this project."
      }
    };
  }

  if (principal.environment !== input.environment) {
    return {
      ok: false,
      error: {
        code: "ENVIRONMENT_MISMATCH",
        message: "Credential environment does not match the requested environment."
      }
    };
  }

  const granted = new Set(principal.scopes);
  const missingScopes = input.requiredScopes.filter((scope) => !granted.has(scope));

  if (missingScopes.length) {
    return {
      ok: false,
      error: {
        code: "SCOPE_MISSING",
        message: "Credential does not have all required scopes.",
        missingScopes
      }
    };
  }

  return { ok: true };
}

export class InMemoryProjectCredentialStore implements ProjectCredentialStore {
  private readonly records = new Map<string, ProjectCredentialRecord>();

  constructor(records: readonly ProjectCredentialRecord[] = []) {
    for (const record of records) {
      this.records.set(record.credentialId, record);
    }
  }

  async getById(credentialId: string): Promise<ProjectCredentialRecord | undefined> {
    return this.records.get(credentialId);
  }
}
