import type { PaymentStatus } from "../domain/models.js";

export type PaymentTransitionDecision =
  | { readonly outcome: "apply" }
  | { readonly outcome: "ignore_duplicate"; readonly reason: string }
  | { readonly outcome: "ignore_stale"; readonly reason: string }
  | { readonly outcome: "reject"; readonly reason: string };

const allowedTransitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ["pending", "authorized", "succeeded", "failed", "cancelled"],
  pending: ["authorized", "succeeded", "failed", "cancelled"],
  authorized: ["succeeded", "failed", "cancelled"],
  succeeded: ["partially_refunded", "refunded"],
  failed: [],
  cancelled: [],
  partially_refunded: ["refunded"],
  refunded: []
};

const progressRank: Readonly<Record<PaymentStatus, number>> = {
  created: 0,
  pending: 1,
  authorized: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
  partially_refunded: 4,
  refunded: 5
};

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "refunded";
}

export function decidePaymentTransition(
  current: PaymentStatus,
  target: PaymentStatus
): PaymentTransitionDecision {
  if (current === target) {
    return {
      outcome: "ignore_duplicate",
      reason: `Payment is already in status "${current}".`
    };
  }

  if (allowedTransitions[current].includes(target)) {
    return { outcome: "apply" };
  }

  if (progressRank[target] < progressRank[current]) {
    return {
      outcome: "ignore_stale",
      reason: `Status "${target}" is older than current status "${current}".`
    };
  }

  return {
    outcome: "reject",
    reason: `Transition from "${current}" to "${target}" is not allowed.`
  };
}
