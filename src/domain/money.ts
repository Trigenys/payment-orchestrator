export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export function createMoney(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError("Money amountMinor must be a safe integer.");
  }

  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new TypeError("Money currency must be a three-letter ISO-style code.");
  }

  return Object.freeze({
    amountMinor,
    currency: normalizedCurrency
  });
}
