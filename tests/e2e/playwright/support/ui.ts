/**
 * Locators for the Trade and Portfolio pages, in one place. They follow docs/design.md (§3 "The
 * four intents", "Transaction state", §5 Trade/Portfolio) and use roles and visible text only; no
 * test ids are needed. TODO(M2-06, M2-07): when those pages merge, check each accessible name below
 * against the real markup and adjust here (the specs themselves should not need to change).
 */
import type { Locator, Page } from "@playwright/test";

export type IntentLabel = "Buy YES" | "Buy NO" | "Sell YES" | "Sell NO";

export const tradePath = (marketAddress: string): string => `/trade/${marketAddress}`;

export const intentButton = (page: Page, intent: IntentLabel): Locator =>
  page.getByRole("radio", { name: new RegExp(`^${intent}`) });

export const priceInput = (page: Page): Locator => page.getByLabel(/price/i);
export const qtyInput = (page: Page): Locator => page.getByLabel(/qty|quantity/i);

/** Select order kind (market or limit) by clicking the corresponding radio button label. */
export const orderKindRadio = (page: Page, kind: "market" | "limit"): Locator =>
  page.getByRole("radio", { name: kind === "market" ? "Market" : "Limit" });

/** The single sign button, e.g. "Sign and buy NO". */
export const signButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^Sign and (buy|sell)/i });

/** The inline status line under the sign button (design.md "Transaction state"). */
export const confirmedStatus = (page: Page): Locator => page.getByText(/Confirmed in slot \d+/);

export const redeemButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^Redeem \$/ });
