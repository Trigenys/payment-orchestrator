export interface CinetPayCredentials {
  readonly apiKey: string;
  readonly siteId: string;
}

export interface CinetPayInitializationData {
  readonly payment_token: string;
  readonly payment_url: string;
}

export interface CinetPayInitializationResponse {
  readonly code: string;
  readonly message: string;
  readonly description?: string;
  readonly data?: CinetPayInitializationData;
  readonly api_response_id?: string;
}

export interface CinetPayVerificationData {
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly payment_method?: string;
  readonly description?: string;
  readonly metadata?: string | null;
  readonly operator_id?: string | null;
  readonly payment_date?: string;
  readonly fund_availability_date?: string;
}

export interface CinetPayVerificationResponse {
  readonly code: string;
  readonly message: string;
  readonly data?: CinetPayVerificationData;
  readonly api_response_id?: string;
}

export interface CinetPayNotificationFields {
  readonly cpm_site_id: string;
  readonly cpm_trans_id: string;
  readonly cpm_trans_date: string;
  readonly cpm_amount: string;
  readonly cpm_currency: string;
  readonly signature: string;
  readonly payment_method: string;
  readonly cel_phone_num: string;
  readonly cpm_phone_prefixe: string;
  readonly cpm_language: string;
  readonly cpm_version: string;
  readonly cpm_payment_config: string;
  readonly cpm_page_action: string;
  readonly cpm_custom: string;
  readonly cpm_designation: string;
  readonly cpm_error_message: string;
}
