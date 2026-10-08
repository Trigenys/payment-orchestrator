export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export type PaymentChannel =
  | "mobile_money"
  | "card"
  | "bank_transfer"
  | "other";

export type PaymentStatus =
  | "created"
  | "pending"
  | "authorized"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "partially_refunded"
  | "refunded";

export interface PaymentCustomer {
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
}

export interface PaymentBeneficiary {
  readonly merchantId: string;
  readonly amount: Money;
}

export interface CreatePaymentRequest {
  readonly merchantId: string;
  readonly amount: Money;
  readonly channel: PaymentChannel;
  readonly customer: PaymentCustomer;
  readonly redirectUrl: string;
  readonly beneficiaries?: readonly PaymentBeneficiary[];
}

export interface PaymentView {
  readonly id: string;
  readonly merchantId: string;
  readonly amount: Money;
  readonly status: PaymentStatus;
  readonly externalReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePaymentResponse {
  readonly payment: PaymentView;
  readonly checkoutUrl?: string;
}

export interface VerifyPaymentResponse {
  readonly payment: PaymentView;
  readonly verifiedAt: string;
}

export interface CreateMerchantRequest {
  readonly displayName: string;
  readonly country: string;
}

export interface MerchantView {
  readonly id: string;
  readonly displayName: string;
  readonly country: string;
  readonly status: "pending" | "active" | "restricted" | "disabled";
  readonly createdAt: string;
}

export type SettlementDestination =
  | {
      readonly type: "bank_account";
      readonly country: string;
      readonly currency: CurrencyCode;
      readonly bankCode: string;
      readonly accountNumber: string;
      readonly accountName?: string;
    }
  | {
      readonly type: "mobile_money";
      readonly country: string;
      readonly currency: CurrencyCode;
      readonly network: string;
      readonly phoneNumber: string;
      readonly accountName?: string;
    };

export interface CreateProviderAccountRequest {
  readonly settlementDestination: SettlementDestination;
  readonly contact?: {
    readonly email?: string;
    readonly phone?: string;
  };
  readonly routing?: {
    readonly provider?: string;
  };
}

export interface ProviderAccountView {
  readonly id: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly environment: "sandbox" | "live";
  readonly status: "pending" | "active" | "restricted" | "disabled";
  readonly createdAt: string;
}

export interface ApiSuccess<T> {
  readonly data: T;
  readonly requestId?: string;
}

export interface ApiErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorPayload;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorResponse;
