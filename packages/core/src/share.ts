import type { IsoDate } from "./dates";
import { Decimal, dec, fixed2, pct2 } from "./money";
import type { RefRate } from "./matching";

/**
 * Banking-channel share for the tax year (data spec, "Derived"):
 *   proceeds received into Pakistani bank accounts / all export proceeds,
 * both in USD at the reference rate on each value date. Money received into a wallet
 * (Payoneer, a marketplace) counts only when it is withdrawn to a Pakistani bank;
 * card spending from the wallet never counts. Wallet balances are tracked first in,
 * first out, so each withdrawal is valued at the rates of the receipts it came from.
 * (verify how the 80% rule is actually measured: data spec open item 4)
 */

export type ShareEvent =
  | { kind: "bank_credit"; id: string; date: IsoDate; currency: string; amount: string }
  | { kind: "wallet_receipt"; id: string; wallet: string; date: IsoDate; currency: string; amount: string }
  | { kind: "wallet_withdrawal"; id: string; wallet: string; date: IsoDate; currency: string; amount: string }
  | { kind: "wallet_spend"; id: string; wallet: string; date: IsoDate; currency: string; amount: string };

export interface ShareLine {
  id: string;
  date: IsoDate;
  kind: ShareEvent["kind"];
  currency: string;
  amount: string;
  usd: string;
  counts: "numerator_and_denominator" | "denominator_only" | "not_proceeds";
  note: string;
}

export interface BankingShare {
  sharePct: string;
  numeratorUsd: string;
  denominatorUsd: string;
  directBankUsd: string;
  walletReceivedUsd: string;
  walletWithdrawnUsd: string;
  walletSpentUsd: string;
  walletHeldUsd: string;
  lines: ShareLine[];
  /** Events skipped because no reference rate was available. */
  missingRates: string[];
}

interface Lot {
  amount: Decimal;
  usdPerUnit: Decimal;
}

export function computeBankingShare(events: ShareEvent[], refRate: RefRate): BankingShare {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || order(a.kind) - order(b.kind));
  const lots = new Map<string, Lot[]>();
  const missingRates: string[] = [];
  const lines: ShareLine[] = [];
  let direct = new Decimal(0);
  let walletReceived = new Decimal(0);
  let walletWithdrawn = new Decimal(0);
  let walletSpent = new Decimal(0);

  const usdPerUnit = (currency: string, date: IsoDate): Decimal | null => {
    if (currency === "USD") return new Decimal(1);
    const ccy = refRate(currency, date);
    const usd = refRate("USD", date);
    if (!ccy || !usd) return null;
    return dec(ccy).div(usd);
  };

  for (const e of sorted) {
    const amount = dec(e.amount);
    if (e.kind === "bank_credit" || e.kind === "wallet_receipt") {
      const rate = usdPerUnit(e.currency, e.date);
      if (!rate) {
        missingRates.push(e.id);
        continue;
      }
      const usd = amount.times(rate);
      if (e.kind === "bank_credit") {
        direct = direct.plus(usd);
        lines.push({ id: e.id, date: e.date, kind: e.kind, currency: e.currency, amount: fixed2(amount), usd: fixed2(usd), counts: "numerator_and_denominator", note: "Received into a Pakistani bank account" });
      } else {
        walletReceived = walletReceived.plus(usd);
        const key = `${e.wallet}|${e.currency}`;
        lots.set(key, [...(lots.get(key) ?? []), { amount, usdPerUnit: rate }]);
        lines.push({ id: e.id, date: e.date, kind: e.kind, currency: e.currency, amount: fixed2(amount), usd: fixed2(usd), counts: "denominator_only", note: `Received into ${e.wallet}; counts as banked only when withdrawn` });
      }
      continue;
    }

    // Withdrawals and spending consume the oldest wallet money first.
    const key = `${e.wallet}|${e.currency}`;
    const queue = lots.get(key) ?? [];
    let left = amount;
    let usd = new Decimal(0);
    while (left.gt(0) && queue.length) {
      const lot = queue[0]!;
      const take = Decimal.min(lot.amount, left);
      usd = usd.plus(take.times(lot.usdPerUnit));
      lot.amount = lot.amount.minus(take);
      left = left.minus(take);
      if (lot.amount.lte(0)) queue.shift();
    }
    lots.set(key, queue);
    if (e.kind === "wallet_withdrawal") {
      walletWithdrawn = walletWithdrawn.plus(usd);
      lines.push({ id: e.id, date: e.date, kind: e.kind, currency: e.currency, amount: fixed2(amount), usd: fixed2(usd), counts: "numerator_and_denominator", note: `Withdrawn from ${e.wallet} to a Pakistani bank` });
    } else {
      walletSpent = walletSpent.plus(usd);
      lines.push({ id: e.id, date: e.date, kind: e.kind, currency: e.currency, amount: fixed2(amount), usd: fixed2(usd), counts: "not_proceeds", note: `Spent from ${e.wallet}; never reaches a Pakistani bank` });
    }
  }

  let held = new Decimal(0);
  for (const queue of lots.values()) for (const lot of queue) held = held.plus(lot.amount.times(lot.usdPerUnit));

  const numerator = direct.plus(walletWithdrawn);
  const denominator = direct.plus(walletReceived);
  const share = denominator.gt(0) ? numerator.div(denominator).times(100) : new Decimal(100);
  return {
    sharePct: pct2(share),
    numeratorUsd: fixed2(numerator),
    denominatorUsd: fixed2(denominator),
    directBankUsd: fixed2(direct),
    walletReceivedUsd: fixed2(walletReceived),
    walletWithdrawnUsd: fixed2(walletWithdrawn),
    walletSpentUsd: fixed2(walletSpent),
    walletHeldUsd: fixed2(held),
    lines,
    missingRates,
  };
}

function order(kind: ShareEvent["kind"]): number {
  return kind === "bank_credit" || kind === "wallet_receipt" ? 0 : 1;
}
