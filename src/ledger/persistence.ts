import type {
  LedgerBatch,
  LedgerEntry,
  LedgerScope
} from "./types.js";

export interface LedgerTransaction {
  getBatch(
    projectId: string,
    sourceKey: string
  ): LedgerBatch | undefined;

  appendBatch(
    batch: LedgerBatch,
    entries: readonly LedgerEntry[]
  ): void;

  listEntries(scope: LedgerScope): readonly LedgerEntry[];
}

export interface LedgerPersistence {
  transaction<T>(
    work: (transaction: LedgerTransaction) => Promise<T> | T
  ): Promise<T>;
}

interface InMemoryLedgerState {
  batches: Map<string, LedgerBatch>;
  entries: LedgerEntry[];
}

function batchKey(projectId: string, sourceKey: string): string {
  return `${projectId}\u0000${sourceKey}`;
}

function cloneState(state: InMemoryLedgerState): InMemoryLedgerState {
  return {
    batches: new Map(state.batches),
    entries: [...state.entries]
  };
}

class InMemoryLedgerTransaction implements LedgerTransaction {
  constructor(private readonly state: InMemoryLedgerState) {}

  getBatch(projectId: string, sourceKey: string): LedgerBatch | undefined {
    return this.state.batches.get(batchKey(projectId, sourceKey));
  }

  appendBatch(
    batch: LedgerBatch,
    entries: readonly LedgerEntry[]
  ): void {
    const key = batchKey(batch.projectId, batch.sourceKey);
    if (this.state.batches.has(key)) {
      throw new Error(
        `Invariant violation: ledger batch "${batch.sourceKey}" already exists for project "${batch.projectId}".`
      );
    }

    this.state.batches.set(key, batch);
    this.state.entries.push(...entries);
  }

  listEntries(scope: LedgerScope): readonly LedgerEntry[] {
    return this.state.entries.filter((entry) => {
      if (entry.projectId !== scope.projectId) return false;
      if (scope.merchantId && entry.merchantId !== scope.merchantId) {
        return false;
      }
      if (scope.paymentId && entry.paymentId !== scope.paymentId) {
        return false;
      }
      return true;
    });
  }
}

export class InMemoryLedgerPersistence implements LedgerPersistence {
  private state: InMemoryLedgerState = {
    batches: new Map(),
    entries: []
  };

  private queue: Promise<void> = Promise.resolve();

  transaction<T>(
    work: (transaction: LedgerTransaction) => Promise<T> | T
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const draft = cloneState(this.state);
      const transaction = new InMemoryLedgerTransaction(draft);
      const result = await work(transaction);
      this.state = draft;
      return result;
    };

    const result = this.queue.then(execute, execute);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}
