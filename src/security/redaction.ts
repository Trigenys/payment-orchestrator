const SENSITIVE_KEY = /(^|[_-])(authorization|cookie|set-cookie|api[-_]?key|secret|token|password|passphrase|pan|cvv|cvc|card[-_]?number|raw[-_]?body)($|[_-])/i;

const API_KEY_LIKE = /\bpo_(?:test|live)_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{16,}\b/g;
const BEARER_LIKE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;

export const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return value
    .replace(API_KEY_LIKE, REDACTED)
    .replace(BEARER_LIKE, `Bearer ${REDACTED}`);
}

export function redactSensitive(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return "[BINARY_REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactSensitive(entryValue, entryKey);
    }

    return output;
  }

  return REDACTED;
}
