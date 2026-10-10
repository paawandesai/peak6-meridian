import { PublicKey } from "@solana/web3.js";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

import { AdminNavLink } from "./admin-nav-link";
import { ADMIN, OWNER, reader, withReader } from "@/test-utils";

afterEach(() => {
  wallet.publicKey = null;
});

function link(admin: string, currentPath = "/") {
  const r = reader({
    getConfig: () => Promise.resolve({ paused: false, overrideDelaySecs: 3600n, admin }),
  });
  return render(withReader(r, <AdminNavLink currentPath={currentPath} />));
}

describe("AdminNavLink", () => {
  it("shows nothing when wallet is not connected (P1-8)", async () => {
    link(ADMIN.toBase58());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows nothing when a non-admin wallet is connected (P1-8)", async () => {
    wallet.publicKey = OWNER;
    link(ADMIN.toBase58());
    await vi.waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });

  it("shows the Admin link when the admin wallet is connected (P1-8)", async () => {
    wallet.publicKey = ADMIN;
    link(ADMIN.toBase58());
    const adminLink = await screen.findByRole("link", { name: "Admin" });
    expect(adminLink).toHaveAttribute("href", "/admin");
    expect(adminLink).not.toHaveAttribute("aria-current");
  });

  it("marks the link as current when on the admin page (P1-8)", async () => {
    wallet.publicKey = ADMIN;
    link(ADMIN.toBase58(), "/admin");
    const adminLink = await screen.findByRole("link", { name: "Admin" });
    expect(adminLink).toHaveAttribute("aria-current", "page");
    expect(adminLink).toHaveClass("font-semibold");
    expect(adminLink).toHaveClass("underline");
  });
});
