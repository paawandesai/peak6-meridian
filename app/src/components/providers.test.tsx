/**
 * Tests for Providers: verifies that status/history/trade shells receive sharedConnection
 * via wallet-adapter's ConnectionContext (P0-4 single Connection app-wide).
 */

import { useConnection } from "@solana/wallet-adapter-react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Providers } from "./providers";

// Mock dependencies
vi.mock("@/lib/chain", () => ({
  createReader: () => ({
    listMarkets: vi.fn(),
    getConfig: vi.fn(),
  }),
}));

vi.mock("@/lib/demo-wallet", () => ({
  registerDemoWallet: vi.fn(),
  setDemoWalletRpcUrl: vi.fn(),
}));

vi.mock("@/lib/rpc", () => ({
  sharedConnection: vi.fn((url: string) => ({ rpcEndpoint: url })),
}));

vi.mock("@/lib/config", () => ({
  loadPublicConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "test",
    network: "devnet",
  }),
}));

vi.mock("./DemoWalletBanner", () => ({
  DemoWalletBanner: () => null,
}));

vi.mock("./markets/data-context", () => ({
  BrowserMarketSources: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./reader-context", () => ({
  ReaderProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Test component that uses useConnection from wallet-adapter-react
function TestConsumer() {
  const { connection } = useConnection();
  return <div data-testid="connection">{connection ? "connected" : "no-connection"}</div>;
}

describe("Providers", () => {
  it("provides sharedConnection via wallet-adapter ConnectionContext for shells", () => {
    const { getByTestId } = render(
      <Providers>
        <TestConsumer />
      </Providers>,
    );
    const element = getByTestId("connection");
    expect(element.textContent).toBe("connected");
  });

  it("connection from useConnection is the sharedConnection instance", async () => {
    const { sharedConnection } = await import("@/lib/rpc");
    let receivedConnection: unknown = null;

    function CapturingConsumer() {
      const { connection } = useConnection();
      receivedConnection = connection;
      return null;
    }

    render(
      <Providers>
        <CapturingConsumer />
      </Providers>,
    );

    expect(receivedConnection).toBeTruthy();
    expect(sharedConnection).toHaveBeenCalledWith("https://api.devnet.solana.com");
  });
});
