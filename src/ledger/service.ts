import { randomUUID } from "node:crypto";
import type { Money } from "../domain/money.js";
import { ledgerFingerprint } from "./fingerprint.js";
import type { LedgerPersistence } from "./persistence.js";
import type {
  AppendLedgerSuccess,
  LedgerEntry,
  LedgerEntryKind,
  LedgerResult,
  ObservePayoutInput,
  ObserveSettlementInput,
  RecordAdjustmentInput,
  RecordPaymentBreakdownInput,
  RecordRefundInput
} from "./types.js";

export interface LedgerServiceDependencies {
  readonly persistence: LedgerPersistence;
  readonly now?: () => string;
  readonly newId?: () => string;
}

interface EvidenceComponent {
  readonly kind: LedgerEntryKind;
  readonly amount: Money;
  readonly adjustmentDirection?: "increase" | "decrease";
  readonly settlementStatus?: ObserveSettlementInput["status"];
}

interface AppendEvidenceInput {
  readonly projectId: string;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly settlementId?: string;
  readonly sourceKey: string;
  readonly components: readonly EvidenceComponent[];
  readonly provider?: string;
  readonly providerReference?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function invalid(message: string): LedgerResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message
    }
  };
}

function validateNonEmpty(
  value: string,
  field: string
): LedgerResult<void> {
  if (!value.trim()) {
    return invalid(`${field} must not be empty.`);
  }

  return { ok: true, value: undefined };
}

function validateMoney(
  money: Money,
  field: string,
  allowZero = false
): LedgerResult<void> {
  if (!Number.isSafeInteger(money.amountMinor)) {
    return invalid(`${field}.amountMinor must be a safe integer.`);
  }

  if (
    allowZero
      ? money.amountMinor < 0
      : money.amountMinor <= 0
  ) {
    return invalid(
      `${field}.amountMinor must be ${allowZero ? "zero or greater" : "greater than zero"}.`
    );
  }

  if (!/^[A-Z]{3}$/.test(money.currency)) {
    return invalid(`${field}.currency must be a normalized three-letter code.`);
  }

  return { ok: true, value: undefined };
}

function validateSameCurrency(
  components: readonly EvidenceComponent[]
): LedgerResult<void> {
  const currencies = new Set(
    components.map((component) => component.amount.currency)
  );

  if (currencies.size > 1) {
    return invalid(
      "All ledger components in one evidence batch must use the same currency."
    );
  }

  return { ok: true, value: undefined };
}

export class LedgerService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly dependencies: LedgerServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.newId = dependencies.newId ?? randomUUID;
  }

  async recordPaymentBreakdown(
    input: RecordPaymentBreakdownInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    const components: EvidenceComponent[] = [
      { kind: "payment_gross", amount: input.gross }
    ];

    if (input.providerFee && input.providerFee.amountMinor > 0) {
      components.push({
        kind: "provider_fee",
        amount: input.providerFee
      });
    }

    if (input.merchantShare && input.merchantShare.amountMinor > 0) {
      components.push({
        kind: "merchant_share",
        amount: input.merchantShare
      });
    }

    if (
      input.platformCommission &&
      input.platformCommission.amountMinor > 0
    ) {
      components.push({
        kind: "platform_commission",
        amount: input.platformCommission
      });
    }

    return this.appendEvidence({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      sourceKey: input.sourceKey,
      components,
      provider: input.provider,
      providerReference: input.providerReference,
      occurredAt: input.occurredAt,
      metadata: input.metadata
    });
  }

  async recordRefund(
    input: RecordRefundInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    return this.appendEvidence({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      sourceKey: input.sourceKey,
      components: [{
        kind: "refund",
        amount: input.amount
      }],
      provider: input.provider,
      providerReference: input.providerReference,
      occurredAt: input.occurredAt,
      metadata: input.metadata
    });
  }

  async recordAdjustment(
    input: RecordAdjustmentInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    const reason = validateNonEmpty(input.reason, "reason");
    if (!reason.ok) return reason;

    return this.appendEvidence({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      sourceKey: input.sourceKey,
      components: [{
        kind: "adjustment",
        amount: input.amount,
        adjustmentDirection: input.direction
      }],
      occurredAt: input.occurredAt,
      metadata: {
        ...input.metadata,
        reason: input.reason
      }
    });
  }

  async observeSettlement(
    input: ObserveSettlementInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    return this.appendEvidence({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      settlementId: input.settlementId,
      sourceKey: input.sourceKey,
      components: [{
        kind: "settlement_observed",
        amount: input.amount,
        settlementStatus: input.status
      }],
      provider: input.provider,
      providerReference: input.providerReference,
      occurredAt: input.occurredAt,
      metadata: input.metadata
    });
  }

  async observePayout(
    input: ObservePayoutInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    return this.appendEvidence({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      sourceKey: input.sourceKey,
      components: [{
        kind: "payout_observed",
        amount: input.amount
      }],
      provider: input.provider,
      providerReference: input.providerReference,
      occurredAt: input.occurredAt,
      metadata: input.metadata
    });
  }

  async listEntries(input: {
    readonly projectId: string;
    readonly merchantId?: string;
    readonly paymentId?: string;
  }): Promise<readonly LedgerEntry[]> {
    return this.dependencies.persistence.transaction((transaction) =>
      transaction.listEntries(input)
    );
  }

  private async appendEvidence(
    input: AppendEvidenceInput
  ): Promise<LedgerResult<AppendLedgerSuccess>> {
    for (const [value, field] of [
      [input.projectId, "projectId"],
      [input.merchantId, "merchantId"],
      [input.sourceKey, "sourceKey"],
      [input.occurredAt, "occurredAt"]
    ] as const) {
      const validation = validateNonEmpty(value, field);
      if (!validation.ok) return validation;
    }

    if (input.components.length === 0) {
      return invalid("Ledger evidence requires at least one component.");
    }

    const duplicateKinds = new Set<LedgerEntryKind>();
    for (const component of input.components) {
      if (duplicateKinds.has(component.kind)) {
        return invalid(
          `Ledger evidence contains duplicate component kind "${component.kind}".`
        );
      }
      duplicateKinds.add(component.kind);

      const money = validateMoney(component.amount, component.kind);
      if (!money.ok) return money;
    }

    const currency = validateSameCurrency(input.components);
    if (!currency.ok) return currency;

    const fingerprint = ledgerFingerprint({
      projectId: input.projectId,
      merchantId: input.merchantId,
      paymentId: input.paymentId,
      settlementId: input.settlementId,
      sourceKey: input.sourceKey,
      components: input.components,
      provider: input.provider,
      providerReference: input.providerReference,
      occurredAt: input.occurredAt,
      metadata: input.metadata
    });

    return this.dependencies.persistence.transaction((transaction) => {
      const existing = transaction.getBatch(
        input.projectId,
        input.sourceKey
      );

      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            ok: false,
            error: {
              code: "ledger_conflict",
              message:
                "The ledger source key was already recorded with different financial evidence.",
              details: {
                projectId: input.projectId,
                sourceKey: input.sourceKey,
                batchId: existing.id
              }
            }
          };
        }

        const entries = transaction
          .listEntries({
            projectId: input.projectId,
            merchantId: input.merchantId,
            paymentId: input.paymentId
          })
          .filter((entry) => entry.batchId === existing.id);

        return {
          ok: true,
          value: {
            batch: existing,
            entries,
            replayed: true
          }
        };
      }

      const recordedAt = this.now();
      const batchId = this.newId();
      const entries: LedgerEntry[] = input.components.map((component) => ({
        id: this.newId(),
        batchId,
        projectId: input.projectId,
        merchantId: input.merchantId,
        paymentId: input.paymentId,
        settlementId: input.settlementId,
        sourceKey: `${input.sourceKey}:${component.kind}`,
        kind: component.kind,
        amount: component.amount,
        adjustmentDirection: component.adjustmentDirection,
        settlementStatus: component.settlementStatus,
        provider: input.provider,
        providerReference: input.providerReference,
        occurredAt: input.occurredAt,
        recordedAt,
        metadata: input.metadata
      }));

      const batch = {
        id: batchId,
        projectId: input.projectId,
        merchantId: input.merchantId,
        paymentId: input.paymentId,
        settlementId: input.settlementId,
        sourceKey: input.sourceKey,
        fingerprint,
        entryIds: entries.map((entry) => entry.id),
        recordedAt
      };

      transaction.appendBatch(batch, entries);

      return {
        ok: true,
        value: {
          batch,
          entries,
          replayed: false
        }
      };
    });
  }
}
