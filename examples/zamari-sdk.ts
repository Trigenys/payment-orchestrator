import {
  TrigenysPaymentsClient,
  createIdempotencyKey
} from "@trigenys/payments";

// Server-side only. Never expose the project API key to the browser.
const payments = new TrigenysPaymentsClient({
  baseUrl: process.env.TRIGENYS_PAYMENTS_URL!,
  apiKey: process.env.TRIGENYS_PAYMENTS_API_KEY!
});

export async function startEnrollmentPayment(input: {
  enrollmentId: string;
  merchantId: string;
  learnerEmail: string;
  amountXaf: number;
  paymentAttemptId: string;
}) {
  return payments.payments.create({
    merchantId: input.merchantId,
    amount: {
      amountMinor: input.amountXaf,
      currency: "XAF"
    },
    channel: "mobile_money",
    customer: {
      email: input.learnerEmail
    },
    redirectUrl: "https://zamari.example/payments/return"
  }, {
    // Stable for this logical payment attempt. Reuse this exact value
    // whenever Zamari retries the same attempt.
    idempotencyKey:
      `zamari-${input.enrollmentId}-${input.paymentAttemptId}`
  });
}
