/**
 * The four intents from the UI, one signature request each (AC2). Written against design.md v2 and
 * M2-06 (!49); fixme until the Trade page (/trade/[market]) merges.
 * TODO(!49 M2-06): remove `fixme` once !49 merges to main, check support/ui.ts locators.
 */
import {
  type Chain,
  fundMaker,
  makerOrder,
  openChain,
  seededMarket,
  tokenBalance,
  tokenAccounts,
} from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor } from "./support/state";
import { connectWallet } from "./support/wallet";
import {
  confirmedStatus,
  intentButton,
  type IntentLabel,
  priceInput,
  qtyInput,
  signButton,
  tradePath,
} from "./support/ui";

const META_STRIKE_CENTS = 68_000n;

type Step = {
  readonly intent: IntentLabel;
  readonly qty: number;
  /** Price in cents of the side being traded (YES price for YES intents, NO price for NO). */
  readonly priceCents: number;
  /** The maker order that gives the wallet something to trade against. */
  readonly maker: Parameters<typeof makerOrder>[3];
  /** Net change of the wallet's YES and NO token balances. */
  readonly yesDelta: bigint;
  readonly noDelta: bigint;
};

const STEPS: readonly Step[] = [
  {
    intent: "Buy YES",
    qty: 5,
    priceCents: 60,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 60, qty: 5n },
    yesDelta: 5n,
    noDelta: 0n,
  },
  {
    intent: "Sell YES",
    qty: 5,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 55, qty: 5n },
    yesDelta: -5n,
    noDelta: 0n,
  },
  {
    intent: "Buy NO",
    qty: 3,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 45, qty: 3n },
    yesDelta: 0n,
    noDelta: 3n,
  },
  {
    intent: "Sell NO",
    qty: 1,
    priceCents: 30,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 70, qty: 1n },
    yesDelta: 0n,
    noDelta: -1n,
  },
];

test("the four intents each ask the wallet for exactly one signature", async ({
  page,
  state,
  wallet,
}) => {
  const connection = connectionFor(state);
  const chain: Chain = openChain(state, connection);
  const market = seededMarket(chain, state, "META", META_STRIKE_CENTS);
  const mine = await tokenAccounts(chain, state, wallet.keypair.publicKey, market);
  const maker = await fundMaker(chain, state, market, 20n);

  await page.goto(tradePath(market.market.toBase58()));
  await connectWallet(page, wallet.keypair.publicKey.toBase58());

  for (const step of STEPS) {
    const yesBefore = await tokenBalance(connection, mine.yes);
    const noBefore = await tokenBalance(connection, mine.no);
    await makerOrder(chain, market, maker, step.maker);

    await intentButton(page, step.intent).click();
    await priceInput(page).fill(String(step.priceCents));
    await qtyInput(page).fill(String(step.qty));
    wallet.reset();
    await signButton(page).click();
    await expect(confirmedStatus(page)).toBeVisible();

    // AC2: one signature request for this trade, not one per instruction or retry.
    expect(wallet.requests(), `${step.intent}: signature requests`).toBe(1);
    expect(await tokenBalance(connection, mine.yes)).toBe(yesBefore + step.yesDelta);
    expect(await tokenBalance(connection, mine.no)).toBe(noBefore + step.noDelta);
  }
});
