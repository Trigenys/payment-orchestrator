import type { ProviderHttpClient } from "../http.js";
import type {
  FapshiCredentials,
  FapshiInitiateResponse,
  FapshiStatusResponse
} from "./types.js";

const SANDBOX_BASE = "https://sandbox.fapshi.com";

export interface FapshiHostedClientOptions {
  readonly httpClient: ProviderHttpClient;
  readonly getCredentials: () => Promise<FapshiCredentials>;
  readonly timeoutMs?: number;
}

export class FapshiHostedClient {
  constructor(private readonly options: FapshiHostedClientOptions) {}

  private async headers(): Promise<Readonly<Record<string, string>>> {
    const credentials = await this.options.getCredentials();
    if (!credentials.apiuser || !credentials.apikey) {
      throw new Error("Missing Fapshi sandbox credentials.");
    }
    return {
      apiuser: credentials.apiuser,
      apikey: credentials.apikey,
      "Content-Type": "application/json",
      Accept: "application/json"
    };
  }

  async initiatePayment(payload: {
    amount: number;
    externalId: string;
    redirectUrl: string;
    email?: string;
  }) {
    return this.options.httpClient.request<FapshiInitiateResponse>({
      method: "POST",
      url: `${SANDBOX_BASE}/initiate-pay`,
      headers: await this.headers(),
      body: payload,
      timeoutMs: this.options.timeoutMs ?? 10_000
    });
  }

  async getStatus(transId: string) {
    return this.options.httpClient.request<FapshiStatusResponse>({
      method: "GET",
      url: `${SANDBOX_BASE}/payment-status/${encodeURIComponent(transId)}`,
      headers: await this.headers(),
      timeoutMs: this.options.timeoutMs ?? 10_000
    });
  }
}
