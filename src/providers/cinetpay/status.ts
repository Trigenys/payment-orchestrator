import type { PaymentStatus } from "../../domain/models.js";

export function mapCinetPayPaymentStatus(status: string): PaymentStatus {
  switch (status.trim().toUpperCase()) {
    case "ACCEPTED":
      return "succeeded";
    case "REFUSED":
      return "failed";
    case "WAITING_FOR_CUSTOMER":
    case "WAITING_CUSTOMER_TO_VALIDATE":
    case "WAITING_CUSTOMER_PAYMENT":
    case "WAITING_CUSTOMER_OTP_CODE":
    case "PENDING":
    case "CREATED":
      return "pending";
    default:
      throw new Error(`Unsupported CinetPay transaction status "${status}".`);
  }
}
