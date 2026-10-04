import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import type { NormalizedProviderPaymentEvent } from "../../payments/types.js";
import type { SecretMaterial } from "../../security/secrets.js";
import type {
  ProviderWebhookAdapter,
  RawWebhookRequest,
  WebhookVerificationResult
} from "../../security/webhooks.js";
import { CinetPayCheckoutClient } from "./client.js";
import { mapCinetPayPaymentStatus } from "./status.js";
import type { CinetPayNotificationFields } from "./types.js";

const HMAC_FIELDS: readonly (keyof CinetPayNotificationFields)[] = [
  "cpm_site_id",
  "cpm_trans_id",
  "cpm_trans_date",
  "cpm_amount",
  "cpm_currency",
  "signature",
  "payment_method",
  "cel_phone_num",
  "cpm_phone_prefixe",
  "cpm_language",
  "cpm_version",
  "cpm_payment_config",
  "cpm_page_action",
  "cpm_custom",
  "cpm_designation",
  "cpm_error_message"
];

function headerValue(
  headers: RawWebhookRequest["headers"],
  name: string
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  const value = entry?.[1];

  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function parseForm(rawBody: Uint8Array): CinetPayNotificationFields {
  const form = new URLSearchParams(Buffer.from(rawBody).toString("utf8"));

  const values = Object.fromEntries(
    HMAC_FIELDS.map((field) => [field, form.get(field) ?? ""])
  ) as unknown as CinetPayNotificationFields;

  if (!values.cpm_trans_id || !values.cpm_site_id) {
    throw new Error("Malformed CinetPay notification payload.");
  }

  return values;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  if (
    leftBuffer.length === 0 ||
    leftBuffer.length !== rightBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export interface CinetPayWebhookAdapterOptions {
  readonly client: CinetPayCheckoutClient;
}

export class CinetPayV2WebhookAdapter implements ProviderWebhookAdapter {
  readonly provider = "cinetpay-v2";

  constructor(private readonly options: CinetPayWebhookAdapterOptions) {}

  async verify(
    request: RawWebhookRequest,
    secrets: readonly SecretMaterial[]
  ): Promise<WebhookVerificationResult> {
    const suppliedToken = headerValue(request.headers, "x-token");

    if (!suppliedToken) {
      return {
        ok: false,
        error: {
          code: "SIGNATURE_MISSING",
          message: "CinetPay x-token header is missing."
        }
      };
    }

    let fields: CinetPayNotificationFields;
    try {
      fields = parseForm(request.rawBody);
    } catch {
      return {
        ok: false,
        error: {
          code: "MALFORMED_REQUEST",
          message: "CinetPay notification form payload is malformed."
        }
      };
    }

    const signedValue = HMAC_FIELDS
      .map((field) => fields[field])
      .join("");

    for (const secret of secrets) {
      const expected = createHmac("sha256", secret.value)
        .update(signedValue)
        .digest("hex");

      if (safeEqualHex(suppliedToken, expected)) {
        return {
          ok: true,
          matchedSecretReferenceId: secret.reference.id,
          verificationMetadata: {
            scheme: "cinetpay-x-token-hmac-sha256",
            transactionId: fields.cpm_trans_id,
            siteId: fields.cpm_site_id
          }
        };
      }
    }

    return {
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message: "CinetPay x-token HMAC did not match an active webhook secret."
      }
    };
  }

  async normalize(
    request: RawWebhookRequest,
    _verification: Extract<WebhookVerificationResult, { readonly ok: true }>
  ): Promise<NormalizedProviderPaymentEvent> {
    const fields = parseForm(request.rawBody);
    const verification = await this.options.client.verifyPayment(
      fields.cpm_trans_id
    );

    if (
      verification.status < 200 ||
      verification.status >= 300 ||
      !verification.body.data
    ) {
      throw new Error(
        "CinetPay notification could not be resolved through the authoritative transaction verification API."
      );
    }

    const status = mapCinetPayPaymentStatus(
      verification.body.data.status
    );

    const eventIdentity = [
      fields.cpm_trans_id,
      status,
      verification.body.data.operator_id ?? "",
      verification.body.data.payment_date ?? ""
    ].join("|");

    return {
      provider: this.provider,
      environment: request.environment,
      eventId: createHash("sha256")
        .update(eventIdentity)
        .digest("hex"),
      providerPaymentReference: fields.cpm_trans_id,
      status,
      occurredAt: request.receivedAt,
      receivedAt: request.receivedAt
    };
  }
}
