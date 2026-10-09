import { PublicKey } from "@solana/web3.js";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  signTransaction: undefined as unknown,
  signAllTransactions: undefined as unknown,
}));
const created = vi.hoisted(() => ({ create: vi.fn(() => ({ approve: vi.fn() })) }));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => wallet,
  useConnection: () => ({ connection: {} }),
}));
vi.mock("./override-chain", () => ({ createOverrideActions: created.create }));

import { AdminOverride } from "./admin-override";
import { ADMIN, reader, withReader } from "@/test-utils";

afterEach(() => {
  wallet.publicKey = null;
  wallet.signTransaction = undefined;
  wallet.signAllTransactions = undefined;
  created.create.mockClear();
});

const mount = () =>
  render(
    withReader(
      reader({
        getConfig: () =>
          Promise.resolve({ paused: false, overrideDelaySecs: 3600n, admin: ADMIN.toBase58() }),
      }),
      <AdminOverride nowSecs={1_791_489_600} />,
    ),
  );

describe("AdminOverride (the admin page mount)", () => {
  it("renders nothing for a disconnected wallet and builds no signing actions", () => {
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
    expect(created.create).not.toHaveBeenCalled();
  });

  it("builds signing actions only once the wallet can sign", async () => {
    wallet.publicKey = ADMIN;
    wallet.signTransaction = vi.fn();
    wallet.signAllTransactions = vi.fn();
    mount();
    expect(await screen.findByRole("heading", { name: "Pending decisions" })).toBeInTheDocument();
    expect(created.create).toHaveBeenCalled();
  });

  it("a wallet that cannot sign gets actions that refuse", async () => {
    wallet.publicKey = ADMIN;
    mount();
    await screen.findByRole("heading", { name: "Pending decisions" });
    expect(created.create).not.toHaveBeenCalled();
  });
});
