import {
  createHash,
  timingSafeEqual
} from "node:crypto";
import type { NormalizedProviderPaymentEvent } from "../../payments/types.js";
import type { SecretMaterial } from "../../security/secrets.js";
import type {
  ProviderWebhookAdapter,
  RawWebhookRequest,
  WebhookVerificationResult
} from "../../security/webhooks.js";
import { mapFlutterwavePaymentStatus } from "./status.js";
import type { FlutterwaveWebhookPayload } from "./types.js";

function headerValue(
  headers: RawWebhookRequest["headers"],
  name: string
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];

  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  const value = entry?.[1];

  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(rawBody: Uint8Array): FlutterwaveWebhookPayload {
  const decoded = Buffer.from(rawBody).toString("utf8");
  const parsed = JSON.parse(decoded) as Partial<FlutterwaveWebhookPayload>;

  if (
    parsed.event !== "charge.completed" ||
    !parsed.data ||
    typeof parsed.data.id !== "number" ||
    typeof parsed.data.tx_ref !== "string" ||
    typeof parsed.data.status !== "string"
  ) {
    throw new Error("Unsupported or malformed Flutterwave v3 webhook payload.");
  }

  return parsed as FlutterwaveWebhookPayload;
}

export class FlutterwaveV3WebhookAdapter implements ProviderWebhookAdapter {
  readonly provider = "flutterwave-v3";

  async verify(
    request: RawWebhookRequest,
    secrets: readonly SecretMaterial[]
  ): Promise<WebhookVerificationResult> {
    const signature = headerValue(request.headers, "verif-hash");

    if (!signature) {
      return {
        ok: false,
        error: {
          code: "SIGNATURE_MISSING",
          message: "Flutterwave v3 verif-hash header is missing."
        }
      };
    }

    for (const secret of secrets) {
      if (safeEqual(signature, secret.value)) {
        return {
          ok: true,
          matchedSecretReferenceId: secret.reference.id,
          verificationMetadata: {
            scheme: "flutterwave-v3-verif-hash"
          }
        };
      }
    }

    return {
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message: "Flutterwave v3 verif-hash did not match an active webhook secret."
      }
    };
  }

  async normalize(
    request: RawWebhookRequest
  ): Promise<NormalizedProviderPaymentEvent> {
    const payload = parsePayload(request.rawBody);
    const status = mapFlutterwavePaymentStatus(payload.data.status);
    const payloadDigest = createHash("sha256")
      .update(request.rawBody)
      .digest("hex");

    return {
      provider: this.provider,
      environment: request.environment,
      eventId: [
        payload.event,
        payload.data.id,
        payload.data.status.toLowerCase()
      ].join(":"),
      providerPaymentReference: payload.data.tx_ref,
      status,
      occurredAt: payload.data.created_at ?? request.receivedAt,
      receivedAt: request.receivedAt,
      payloadDigest
    };
  }
}
