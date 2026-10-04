import type { ProviderHttpClient } from "../http.js";
import type {
  CinetPayCredentials,
  CinetPayInitializationResponse,
  CinetPayVerificationResponse
} from "./types.js";

const CHECKOUT_BASE = "https://api-checkout.cinetpay.com/v2";

export interface CinetPayCheckoutClientOptions {
  readonly httpClient: ProviderHttpClient;
  readonly getCredentials: () => Promise<CinetPayCredentials>;
  readonly userAgent?: string;
}

export class CinetPayCheckoutClient {
  constructor(private readonly options: CinetPayCheckoutClientOptions) {}

  async initializePayment(body: Readonly<Record<string, unknown>>) {
    const credentials = await this.options.getCredentials();

    return this.options.httpClient.request<CinetPayInitializationResponse>({
      method: "POST",
      url: `${CHECKOUT_BASE}/payment`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": this.options.userAgent ?? "Trigenys-Payment-Orchestrator/0.1"
      },
      body: {
        ...body,
        apikey: credentials.apiKey,
        site_id: credentials.siteId
      }
    });
  }

  async verifyPayment(transactionId: string) {
    const credentials = await this.options.getCredentials();

    return this.options.httpClient.request<CinetPayVerificationResponse>({
      method: "POST",
      url: `${CHECKOUT_BASE}/payment/check`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": this.options.userAgent ?? "Trigenys-Payment-Orchestrator/0.1"
      },
      body: {
        transaction_id: transactionId,
        site_id: credentials.siteId,
        apikey: credentials.apiKey
      }
    });
  }
}
