/**
 * An independent reference model of the lifecycle's economics (M1-10 AC3): cash, YES and NO
 * per trader, driven only by what the script intends (mint, trade at a price, pair redeem,
 * outcome), never by reading the chain. The chain's final USDC must equal it exactly.
 * Money is bigint USDC base units; prices are whole cents.
 */
export const UNITS_PER_USDC = 1_000_000n;
export const UNITS_PER_CENT = 10_000n;

export type Holdings = { cash: bigint; yes: bigint; no: bigint };

export class Ledger {
  private readonly holdings = new Map<string, Holdings>();

  constructor(names: readonly string[]) {
    for (const name of names) {
      this.holdings.set(name, { cash: 0n, yes: 0n, no: 0n });
    }
  }

  private of(name: string): Holdings {
    const holding = this.holdings.get(name);
    if (holding === undefined) {
      throw new Error(`unknown trader ${name}`);
    }
    return holding;
  }

  /** Deposit `n` USDC, receive `n` YES + `n` NO. */
  mintPairs(name: string, n: bigint): void {
    const h = this.of(name);
    h.cash -= n * UNITS_PER_USDC;
    h.yes += n;
    h.no += n;
  }

  /** `buyer` pays `n` × `priceCents` to `seller` for `n` YES. */
  trade(buyer: string, seller: string, priceCents: bigint, n: bigint): void {
    const value = n * priceCents * UNITS_PER_CENT;
    const b = this.of(buyer);
    const s = this.of(seller);
    b.cash -= value;
    b.yes += n;
    s.cash += value;
    s.yes -= n;
  }

  /** Burn `n` YES + `n` NO for `n` USDC. */
  redeemPairs(name: string, n: bigint): void {
    const h = this.of(name);
    h.cash += n * UNITS_PER_USDC;
    h.yes -= n;
    h.no -= n;
  }

  /** After settlement every winning token pays 1 USDC and every losing token 0; all are burned. */
  redeemWinners(name: string, yesWins: boolean): void {
    const h = this.of(name);
    h.cash += (yesWins ? h.yes : h.no) * UNITS_PER_USDC;
    h.yes = 0n;
    h.no = 0n;
  }

  get(name: string): Readonly<Holdings> {
    return { ...this.of(name) };
  }
}
