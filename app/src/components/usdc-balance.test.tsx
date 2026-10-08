import { PublicKey } from "@solana/web3.js";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UsdcBalance } from "./usdc-balance";
import { OWNER, reader, withReader } from "@/test-utils";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

describe("UsdcBalance", () => {
  beforeEach(() => {
    wallet.publicKey = null;
  });

  it("renders nothing without a connected wallet", () => {
    const { container } = render(withReader(reader(), <UsdcBalance />));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the connected wallet's balance in USDC", async () => {
    wallet.publicKey = OWNER;
    render(withReader(reader({ usdcBalance: () => Promise.resolve(1_250_000n) }), <UsdcBalance />));
    expect(screen.getByRole("status")).toHaveTextContent("Loading balance");
    expect(await screen.findByText("1.25 test-USDC")).toBeInTheDocument();
  });

  it("says so when no mint is configured", async () => {
    wallet.publicKey = OWNER;
    render(withReader(reader({ usdcBalance: () => Promise.resolve(null) }), <UsdcBalance />));
    expect(await screen.findByText(/mint not configured/)).toBeInTheDocument();
  });

  it("shows an error when the balance fetch fails", async () => {
    wallet.publicKey = OWNER;
    render(
      withReader(reader({ usdcBalance: () => Promise.reject(new Error("boom")) }), <UsdcBalance />),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Balance unavailable: boom");
  });
});
