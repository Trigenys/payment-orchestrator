import type { PaymentStatus } from "../../domain/models.js";

export function mapFlutterwavePaymentStatus(status: string): PaymentStatus {
  switch (status.trim().toLowerCase()) {
    case "successful":
    case "success":
      return "succeeded";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      throw new Error(`Unsupported Flutterwave transaction status "${status}".`);
  }
}
