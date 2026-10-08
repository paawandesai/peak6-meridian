import { PublicKey } from "@solana/web3.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

import { FaucetButton } from "./faucet-button";

const KEY = new PublicKey("11111111111111111111111111111112");

afterEach(() => {
  vi.unstubAllGlobals();
  wallet.publicKey = null;
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("FaucetButton", () => {
  it("renders nothing until a wallet is connected", () => {
    const { container } = render(<FaucetButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it("requests test-USDC for the connected wallet and shows the amount", async () => {
    wallet.publicKey = KEY;
    const fetchMock = stubFetch(200, { signature: "sig", amount_base_units: "1000000000" });
    render(<FaucetButton />);
    fireEvent.click(screen.getByRole("button", { name: "Get test-USDC" }));
    expect(await screen.findByText("Received 1,000.00 test-USDC.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/faucet");
    expect(JSON.parse(String(init.body))).toEqual({ wallet: KEY.toBase58() });
  });

  it("shows the server's message for a refused claim (the 24 h rule)", async () => {
    wallet.publicKey = KEY;
    stubFetch(429, { error: "This wallet already claimed test-USDC. One claim per 24 hours." });
    render(<FaucetButton />);
    fireEvent.click(screen.getByRole("button", { name: "Get test-USDC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("One claim per 24 hours");
  });

  it("says the faucet could not be reached when the request or the reply is broken", async () => {
    wallet.publicKey = KEY;
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    render(<FaucetButton />);
    fireEvent.click(screen.getByRole("button", { name: "Get test-USDC" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("could not be reached"),
    );
  });
});
