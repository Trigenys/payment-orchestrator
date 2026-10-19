import type { PaymentStatus } from "../../domain/models.js";

/**
 * FAILED can describe a failed mobile-money attempt while a hosted checkout
 * still allows another attempt; never close an entire order based on this
 * state until its semantics have been verified for the Trigenys service.
 */
export function mapFapshiStatus(status: string): PaymentStatus {
  switch (status) {
    case "CREATED":
    case "PENDING":
    case "FAILED":
      return "pending";
    case "SUCCESSFUL":
      return "succeeded";
    case "EXPIRED":
      return "cancelled";
    default:
      throw new Error("Unsupported Fapshi status.");
  }
}
