import type { ReconciliationRun } from "./types.js";

export interface ReconciliationTransaction {
  getRun(key: string): ReconciliationRun | undefined;
  appendRun(run: ReconciliationRun): void;
  listRuns(input: {
    readonly projectId: string;
    readonly merchantId?: string;
    readonly subjectId?: string;
  }): readonly ReconciliationRun[];
}

export interface ReconciliationPersistence {
  transaction<T>(
    work: (transaction: ReconciliationTransaction) => Promise<T> | T
  ): Promise<T>;
}

class InMemoryReconciliationTransaction
implements ReconciliationTransaction {
  constructor(
    private readonly runs: Map<string, ReconciliationRun>
  ) {}

  getRun(key: string): ReconciliationRun | undefined {
    return this.runs.get(key);
  }

  appendRun(run: ReconciliationRun): void {
    if (this.runs.has(run.key)) {
      throw new Error(
        `Invariant violation: reconciliation run "${run.key}" already exists.`
      );
    }

    this.runs.set(run.key, run);
  }

  listRuns(input: {
    readonly projectId: string;
    readonly merchantId?: string;
    readonly subjectId?: string;
  }): readonly ReconciliationRun[] {
    return [...this.runs.values()]
      .filter((run) => {
        if (run.projectId !== input.projectId) return false;
        if (
          input.merchantId &&
          run.merchantId !== input.merchantId
        ) {
          return false;
        }
        if (
          input.subjectId &&
          run.subjectId !== input.subjectId
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );
  }
}

export class InMemoryReconciliationPersistence
implements ReconciliationPersistence {
  private runs = new Map<string, ReconciliationRun>();
  private queue: Promise<void> = Promise.resolve();

  transaction<T>(
    work: (transaction: ReconciliationTransaction) => Promise<T> | T
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const draft = new Map(this.runs);
      const transaction =
        new InMemoryReconciliationTransaction(draft);
      const result = await work(transaction);
      this.runs = draft;
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
