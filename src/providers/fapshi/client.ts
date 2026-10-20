import type { ProviderHttpClient } from "../http.js";
import type { ProviderEnvironment } from "../capabilities.js";
import { fapshiBaseUrl, parseFapshiEnvironment } from "./environment.js";
import type {
  FapshiCredentials,
  FapshiInitiateResponse,
  FapshiStatusResponse
} from "./types.js";

export interface FapshiHostedClientOptions {
  /** Defaults to sandbox for existing consumers; live must be explicit. */
  readonly environment?: ProviderEnvironment;
  readonly httpClient: ProviderHttpClient;
  readonly getCredentials: () => Promise<FapshiCredentials>;
  readonly timeoutMs?: number;
}

export class FapshiHostedClient {
  readonly environment: ProviderEnvironment;
  private readonly baseUrl: string;

  constructor(private readonly options: FapshiHostedClientOptions) {
    this.environment = parseFapshiEnvironment(options.environment ?? "sandbox");
    this.baseUrl = fapshiBaseUrl(this.environment);
  }

  private async headers(): Promise<Readonly<Record<string, string>>> {
    const credentials = await this.options.getCredentials();
    if (!credentials.apiuser || !credentials.apikey) {
      throw new Error("Missing Fapshi credentials for the configured environment.");
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
      url: `${this.baseUrl}/initiate-pay`,
      headers: await this.headers(),
      body: payload,
      timeoutMs: this.options.timeoutMs ?? 10_000
    });
  }

  async getStatus(transId: string) {
    return this.options.httpClient.request<FapshiStatusResponse>({
      method: "GET",
      url: `${this.baseUrl}/payment-status/${encodeURIComponent(transId)}`,
      headers: await this.headers(),
      timeoutMs: this.options.timeoutMs ?? 10_000
    });
  }
}
