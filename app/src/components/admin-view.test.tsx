import { PublicKey } from "@solana/web3.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

import { AdminView, CONNECT_TEXT, NOT_ADMIN_TEXT } from "./admin-view";
import type { AdminActions } from "@/lib/admin-chain";
import { ADMIN, market, OWNER, reader, withReader } from "@/test-utils";

const NOW = 1_767_639_600; // 2026-01-05 14:00 ET
const today = market({
  tradingDate: 20260105,
  closeTs: BigInt(NOW + 3 * 3600),
  strikeCents: 22_000n,
});

afterEach(() => {
  wallet.publicKey = null;
});

function actions(overrides: Partial<AdminActions> = {}): AdminActions {
  return {
    addStrike: vi.fn().mockResolvedValue({ signature: "SIG1", slot: 42 }),
    setPaused: vi.fn().mockResolvedValue({ signature: "SIG2", slot: 43 }),
    ...overrides,
  };
}

function view(a: AdminActions, paused = false) {
  const r = reader({
    getConfig: () => Promise.resolve({ paused, overrideDelaySecs: 3600n, admin: ADMIN.toBase58() }),
    listMarkets: () => Promise.resolve([today]),
  });
  return render(
    withReader(
      r,
      <AdminView actions={a} nowSecs={NOW} explorerUrl={(s) => `https://explorer.test/tx/${s}`} />,
    ),
  );
}

describe("AdminView access", () => {
  it("asks a disconnected visitor to connect and shows no controls", () => {
    view(actions());
    expect(screen.getByText(CONNECT_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a non-admin wallet no admin actions at all", async () => {
    wallet.publicKey = OWNER;
    view(actions());
    expect(await screen.findByText(NOT_ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("reports a config read failure", async () => {
    wallet.publicKey = ADMIN;
    render(
      withReader(
        reader({ getConfig: () => Promise.reject(new Error("rpc down")) }),
        <AdminView actions={actions()} nowSecs={NOW} explorerUrl={String} />,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("rpc down");
  });
});

describe("pause control (UI-08 AC2)", () => {
  it("states what stops and what keeps working, then pauses with one signature", async () => {
    wallet.publicKey = ADMIN;
    const a = actions();
    view(a);
    expect(await screen.findByText("Trading is running.")).toBeInTheDocument();
    expect(
      screen.getByText("Mint pair, new orders, Buy NO and Sell NO are stopped for every market."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Cancel, withdraw (settle funds), redeem and automatic settlement keep working.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause trading" }));
    expect(await screen.findByText("Confirmed in slot 42".replace("42", "43"))).toBeInTheDocument();
    expect(a.setPaused).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("link", { name: "(view on explorer)" })).toHaveAttribute(
      "href",
      "https://explorer.test/tx/SIG2",
    );
  });

  it("offers unpause while paused and says what resumes", async () => {
    wallet.publicKey = ADMIN;
    const a = actions();
    view(a, true);
    expect(await screen.findByText("Trading is paused.")).toBeInTheDocument();
    expect(screen.getByText(/lets traders mint, place orders/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unpause trading" }));
    await waitFor(() => expect(a.setPaused).toHaveBeenCalledWith(false));
  });

  it("shows the failure and that nothing was charged when the wallet rejects", async () => {
    wallet.publicKey = ADMIN;
    view(actions({ setPaused: vi.fn().mockRejectedValue(new Error("User rejected the request")) }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause trading" }));
    expect(
      await screen.findByText(/Failed: User rejected the request\. Nothing was charged\./),
    ).toBeInTheDocument();
  });
});

describe("add strike form", () => {
  async function ready(a: AdminActions) {
    wallet.publicKey = ADMIN;
    view(a);
    return screen.findByRole("button", { name: "Add strike" });
  }

  it("signs once for a valid strike and clears the field", async () => {
    const a = actions();
    const submit = await ready(a);
    fireEvent.change(screen.getByLabelText("Ticker"), { target: { value: "NVDA" } });
    fireEvent.change(screen.getByLabelText(/Strike/), { target: { value: "180" } });
    fireEvent.click(submit);
    expect(await screen.findByText("Confirmed in slot 42")).toBeInTheDocument();
    expect(a.addStrike).toHaveBeenCalledExactlyOnceWith({
      ticker: "NVDA",
      strikeCents: 18_000n,
      tradingDate: 20260105,
      closeTs: BigInt(NOW + 3 * 3600),
    });
    expect(screen.getByLabelText(/Strike/)).toHaveValue("");
  });

  it("rejects a duplicate with clear text and never calls the wallet", async () => {
    const a = actions();
    const submit = await ready(a);
    fireEvent.change(screen.getByLabelText(/Strike/), { target: { value: "220" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AAPL $220 already exists for today. Choose a different strike.",
    );
    expect(a.addStrike).not.toHaveBeenCalled();
  });

  it("rejects a bad strike", async () => {
    const a = actions();
    const submit = await ready(a);
    fireEvent.change(screen.getByLabelText(/Strike/), { target: { value: "225" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("multiple of $10");
    expect(screen.getByLabelText(/Strike/)).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the input and shows the program's error when the transaction fails", async () => {
    const a = actions({
      addStrike: vi.fn().mockRejectedValue(new Error("Close time must be in the future")),
    });
    const submit = await ready(a);
    fireEvent.change(screen.getByLabelText(/Strike/), { target: { value: "250" } });
    fireEvent.click(submit);
    expect(await screen.findByText(/Failed: Close time must be in the future/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Strike/)).toHaveValue("250");
  });
});
