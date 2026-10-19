export interface FapshiCredentials {
  readonly apiuser: string;
  readonly apikey: string;
}

export interface FapshiInitiateResponse {
  readonly message?: string;
  readonly link?: string;
  readonly transId?: string;
  readonly dateInitiated?: string;
}

export type FapshiProviderStatus =
  | "CREATED"
  | "PENDING"
  | "SUCCESSFUL"
  | "FAILED"
  | "EXPIRED";

export interface FapshiStatusResponse {
  readonly transId?: string;
  readonly status?: FapshiProviderStatus | string;
  readonly transType?: string;
  readonly serviceName?: string;
  readonly amount?: number;
  readonly revenue?: number;
  readonly externalId?: string;
  readonly medium?: string;
  readonly dateInitiated?: string;
  readonly dateConfirmed?: string;
  readonly message?: string;
}
