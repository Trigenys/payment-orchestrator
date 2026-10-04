export interface FlutterwaveEnvelope<T> {
  readonly status: string;
  readonly message: string;
  readonly data: T;
}

export interface FlutterwaveCollectionSubaccount {
  readonly id: number;
  readonly account_number: string;
  readonly account_bank: string;
  readonly full_name?: string;
  readonly business_name?: string;
  readonly subaccount_id: string;
  readonly bank_name?: string;
  readonly country?: string;
  readonly split_type?: string;
  readonly split_value?: number;
}

export interface FlutterwaveHostedPaymentLink {
  readonly link: string;
}

export interface FlutterwaveVerifiedTransaction {
  readonly id: number;
  readonly tx_ref: string;
  readonly flw_ref: string;
  readonly amount: number;
  readonly currency: string;
  readonly charged_amount?: number;
  readonly app_fee?: number;
  readonly merchant_fee?: number;
  readonly status: string;
  readonly payment_type?: string;
  readonly created_at?: string;
  readonly amount_settled?: number;
}

export interface FlutterwaveWebhookPayload {
  readonly event: string;
  readonly data: {
    readonly id: number;
    readonly tx_ref: string;
    readonly flw_ref?: string;
    readonly amount?: number;
    readonly currency?: string;
    readonly status: string;
    readonly payment_type?: string;
    readonly created_at?: string;
  };
}
