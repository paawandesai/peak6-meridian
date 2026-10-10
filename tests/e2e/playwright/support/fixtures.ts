/** `test` with the stack state, the funded wallet's keypair and the injected wallet on every page. */
import { test as base } from "@playwright/test";

import { type StackState, keypairFrom, loadState } from "./state";
import { installTestWallet, type TestWallet } from "./wallet";

export const test = base.extend<{ state: StackState; wallet: TestWallet }>({
  // eslint-disable-next-line no-empty-pattern
  state: async ({}, use) => {
    await use(loadState());
  },
  wallet: async ({ page, state }, use) => {
    await use(await installTestWallet(page, keypairFrom(state.walletSecret)));
  },
});

export { expect } from "@playwright/test";
