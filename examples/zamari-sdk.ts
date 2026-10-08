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
    // In a real Zamari integration, persist a stable key with the
    // enrollment/payment attempt instead of generating a new key on every retry.
    idempotencyKey: createIdempotencyKey(
      `zamari-${input.enrollmentId}`
    )
  });
}
