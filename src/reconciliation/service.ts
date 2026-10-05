import { randomUUID } from "node:crypto";
import type { Money } from "../domain/money.js";
import type {
  PaymentStatus,
  SettlementStatus
} from "../domain/models.js";
import { ledgerFingerprint } from "../ledger/fingerprint.js";
import type { LedgerPersistence } from "../ledger/persistence.js";
import type {
  LedgerEntry,
  LedgerEntryKind
} from "../ledger/types.js";
import type { ReconciliationPersistence } from "./persistence.js";
import type {
  AuthoritativePaymentFinancials,
  ReconcilePaymentInput,
  ReconcileSettlementInput,
  ReconciliationDiscrepancy,
  ReconciliationResult,
  ReconciliationRun,
  ReconciliationSuccess
} from "./types.js";

export interface ReconciliationServiceDependencies {
  readonly ledgerPersistence: LedgerPersistence;
  readonly persistence: ReconciliationPersistence;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function invalid(
  message: string
): ReconciliationResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message
    }
  };
}

function scopeMismatch(
  message: string,
  details?: Readonly<Record<string, unknown>>
): ReconciliationResult<never> {
  return {
    ok: false,
    error: {
      code: "scope_mismatch",
      message,
      details
    }
  };
}

function sameMoney(
  left: Money,
  right: Money
): boolean {
  return (
    left.currency === right.currency &&
    left.amountMinor === right.amountMinor
  );
}

function moneyShape(money: Money): Readonly<Record<string, unknown>> {
  return {
    amountMinor: money.amountMinor,
    currency: money.currency
  };
}

function sumComponent(
  entries: readonly LedgerEntry[],
  kind: LedgerEntryKind
): {
  readonly count: number;
  readonly money?: Money;
} {
  const matches = entries.filter((entry) => entry.kind === kind);
  if (matches.length === 0) {
    return { count: 0 };
  }

  const currency = matches[0]!.amount.currency;
  if (matches.some((entry) => entry.amount.currency !== currency)) {
    return {
      count: matches.length
    };
  }

  return {
    count: matches.length,
    money: {
      amountMinor: matches.reduce(
        (sum, entry) => sum + entry.amount.amountMinor,
        0
      ),
      currency
    }
  };
}

function compareLedgerComponent(
  discrepancies: ReconciliationDiscrepancy[],
  entries: readonly LedgerEntry[],
  kind: LedgerEntryKind,
  expected: Money
): void {
  const component = sumComponent(entries, kind);

  if (component.count === 0) {
    discrepancies.push({
      type: "ledger_component_missing",
      component: kind,
      message: `Ledger component "${kind}" is missing.`,
      expected: moneyShape(expected)
    });
    return;
  }

  if (component.count > 1) {
    discrepancies.push({
      type: "ledger_component_duplicate",
      component: kind,
      message:
        `Ledger component "${kind}" has multiple observations for the same payment scope.`,
      expected: 1,
      actual: component.count
    });
  }

  if (!component.money || !sameMoney(component.money, expected)) {
    discrepancies.push({
      type: "ledger_component_mismatch",
      component: kind,
      message: `Ledger component "${kind}" does not match authoritative financial evidence.`,
      expected: moneyShape(expected),
      actual: component.money
        ? moneyShape(component.money)
        : { reason: "mixed currencies" }
    });
  }
}

function comparePaymentStatus(
  discrepancies: ReconciliationDiscrepancy[],
  internal: PaymentStatus,
  authoritative: PaymentStatus
): void {
  if (internal !== authoritative) {
    discrepancies.push({
      type: "status_mismatch",
      message:
        "Internal payment status differs from authoritative provider status.",
      expected: authoritative,
      actual: internal
    });
  }
}

function compareSettlementStatus(
  discrepancies: ReconciliationDiscrepancy[],
  internal: SettlementStatus,
  authoritative: SettlementStatus
): void {
  if (internal !== authoritative) {
    discrepancies.push({
      type: "settlement_status_mismatch",
      message:
        "Internal settlement status differs from authoritative provider status.",
      expected: authoritative,
      actual: internal
    });
  }
}

export class ReconciliationService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly dependencies: ReconciliationServiceDependencies
  ) {
    this.now =
      dependencies.now ?? (() => new Date().toISOString());
    this.newId = dependencies.newId ?? randomUUID;
  }

  async reconcilePayment(
    input: ReconcilePaymentInput
  ): Promise<ReconciliationResult<ReconciliationSuccess>> {
    if (!input.provider.trim()) {
      return invalid("provider must not be empty.");
    }

    if (
      input.payment.projectId !== input.projectId ||
      input.payment.merchantId !== input.merchantId
    ) {
      return scopeMismatch(
        "Payment does not belong to the requested project/merchant scope.",
        {
          paymentProjectId: input.payment.projectId,
          paymentMerchantId: input.payment.merchantId
        }
      );
    }

    const entries =
      await this.dependencies.ledgerPersistence.transaction(
        (transaction) =>
          transaction.listEntries({
            projectId: input.projectId,
            merchantId: input.merchantId,
            paymentId: input.payment.id
          })
      );

    const discrepancies: ReconciliationDiscrepancy[] = [];

    if (
      input.payment.externalReference !==
      input.authoritative.externalReference
    ) {
      discrepancies.push({
        type: "external_reference_mismatch",
        message:
          "Internal external reference differs from authoritative provider reference.",
        expected: input.authoritative.externalReference,
        actual: input.payment.externalReference
      });
    }

    if (
      input.expectedProviderReference &&
      input.expectedProviderReference !==
        input.authoritative.providerReference
    ) {
      discrepancies.push({
        type: "provider_reference_mismatch",
        message:
          "Expected provider-native reference differs from authoritative provider reference.",
        expected: input.expectedProviderReference,
        actual: input.authoritative.providerReference
      });
    }

    if (
      input.payment.amount.currency !==
      input.authoritative.amount.currency
    ) {
      discrepancies.push({
        type: "currency_mismatch",
        message:
          "Internal payment currency differs from authoritative provider currency.",
        expected: input.authoritative.amount.currency,
        actual: input.payment.amount.currency
      });
    }

    if (
      input.payment.amount.amountMinor !==
      input.authoritative.amount.amountMinor
    ) {
      discrepancies.push({
        type: "amount_mismatch",
        message:
          "Internal payment amount differs from authoritative provider amount.",
        expected: input.authoritative.amount.amountMinor,
        actual: input.payment.amount.amountMinor
      });
    }

    comparePaymentStatus(
      discrepancies,
      input.payment.status,
      input.authoritative.status
    );

    compareLedgerComponent(
      discrepancies,
      entries,
      "payment_gross",
      input.authoritative.amount
    );

    this.compareFinancials(
      discrepancies,
      entries,
      input.financials
    );

    return this.persistRun({
      projectId: input.projectId,
      merchantId: input.merchantId,
      subjectType: "payment",
      subjectId: input.payment.id,
      provider: input.provider,
      providerReference: input.authoritative.providerReference,
      snapshot: {
        paymentVersion: input.payment.version,
        payment: input.payment,
        authoritative: input.authoritative,
        financials: input.financials,
        ledgerEntryIds: entries.map((entry) => entry.id).sort(),
        discrepancies
      },
      discrepancies
    });
  }

  async reconcileSettlement(
    input: ReconcileSettlementInput
  ): Promise<ReconciliationResult<ReconciliationSuccess>> {
    if (!input.provider.trim()) {
      return invalid("provider must not be empty.");
    }

    const entries =
      await this.dependencies.ledgerPersistence.transaction(
        (transaction) =>
          transaction.listEntries({
            projectId: input.projectId,
            merchantId: input.merchantId
          })
      );

    const settlementEntries = entries.filter(
      (entry) =>
        entry.settlementId === input.settlement.id &&
        entry.kind === "settlement_observed"
    );

    const discrepancies: ReconciliationDiscrepancy[] = [];

    if (
      input.settlement.merchantId !== input.merchantId ||
      input.authoritative.merchantId !== input.merchantId
    ) {
      return scopeMismatch(
        "Settlement does not belong to the requested merchant scope."
      );
    }

    if (
      input.settlement.amount.currency !==
      input.authoritative.amount.currency
    ) {
      discrepancies.push({
        type: "currency_mismatch",
        message:
          "Internal settlement currency differs from authoritative provider currency.",
        expected: input.authoritative.amount.currency,
        actual: input.settlement.amount.currency
      });
    }

    if (
      input.settlement.amount.amountMinor !==
      input.authoritative.amount.amountMinor
    ) {
      discrepancies.push({
        type: "amount_mismatch",
        message:
          "Internal settlement amount differs from authoritative provider amount.",
        expected: input.authoritative.amount.amountMinor,
        actual: input.settlement.amount.amountMinor
      });
    }

    compareSettlementStatus(
      discrepancies,
      input.settlement.status,
      input.authoritative.status
    );

    if (
      input.settlement.providerReference &&
      input.authoritative.providerReference &&
      input.settlement.providerReference !==
        input.authoritative.providerReference
    ) {
      discrepancies.push({
        type: "provider_reference_mismatch",
        message:
          "Internal settlement provider reference differs from authoritative provider reference.",
        expected: input.authoritative.providerReference,
        actual: input.settlement.providerReference
      });
    }

    if (settlementEntries.length === 0) {
      discrepancies.push({
        type: "ledger_component_missing",
        component: "settlement_observed",
        message:
          "No settlement observation exists in the ledger.",
        expected: moneyShape(input.authoritative.amount)
      });
    } else {
      compareLedgerComponent(
        discrepancies,
        settlementEntries,
        "settlement_observed",
        input.authoritative.amount
      );
    }

    return this.persistRun({
      projectId: input.projectId,
      merchantId: input.merchantId,
      subjectType: "settlement",
      subjectId: input.settlement.id,
      provider: input.provider,
      providerReference:
        input.authoritative.providerReference,
      snapshot: {
        internal: input.settlement,
        authoritative: input.authoritative,
        ledgerEntryIds: settlementEntries
          .map((entry) => entry.id)
          .sort(),
        discrepancies
      },
      discrepancies
    });
  }

  async listRuns(input: {
    readonly projectId: string;
    readonly merchantId?: string;
    readonly subjectId?: string;
  }): Promise<readonly ReconciliationRun[]> {
    return this.dependencies.persistence.transaction(
      (transaction) => transaction.listRuns(input)
    );
  }

  private compareFinancials(
    discrepancies: ReconciliationDiscrepancy[],
    entries: readonly LedgerEntry[],
    financials: AuthoritativePaymentFinancials | undefined
  ): void {
    if (!financials) return;

    if (financials.providerFee) {
      compareLedgerComponent(
        discrepancies,
        entries,
        "provider_fee",
        financials.providerFee
      );
    }

    if (financials.merchantShare) {
      compareLedgerComponent(
        discrepancies,
        entries,
        "merchant_share",
        financials.merchantShare
      );
    }

    if (financials.platformCommission) {
      compareLedgerComponent(
        discrepancies,
        entries,
        "platform_commission",
        financials.platformCommission
      );
    }
  }

  private async persistRun(input: {
    readonly projectId: string;
    readonly merchantId: string;
    readonly subjectType: "payment" | "settlement";
    readonly subjectId: string;
    readonly provider: string;
    readonly providerReference?: string;
    readonly snapshot: unknown;
    readonly discrepancies: readonly ReconciliationDiscrepancy[];
  }): Promise<ReconciliationResult<ReconciliationSuccess>> {
    const fingerprint = ledgerFingerprint(input.snapshot);
    const key = ledgerFingerprint({
      projectId: input.projectId,
      merchantId: input.merchantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      provider: input.provider,
      providerReference: input.providerReference,
      fingerprint
    });

    return this.dependencies.persistence.transaction(
      (transaction) => {
        const existing = transaction.getRun(key);
        if (existing) {
          return {
            ok: true,
            value: {
              run: existing,
              replayed: true
            }
          };
        }

        const run: ReconciliationRun = {
          id: this.newId(),
          key,
          fingerprint,
          projectId: input.projectId,
          merchantId: input.merchantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          provider: input.provider,
          providerReference: input.providerReference,
          status:
            input.discrepancies.length === 0
              ? "matched"
              : "discrepancy",
          discrepancies: input.discrepancies,
          createdAt: this.now()
        };

        transaction.appendRun(run);

        return {
          ok: true,
          value: {
            run,
            replayed: false
          }
        };
      }
    );
  }
}
