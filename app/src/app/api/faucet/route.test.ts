// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());

vi.mock("@/lib/faucet/instance", () => ({ createFaucetFromEnv: create }));

import { FaucetConfigError } from "@/lib/faucet/env";
import { FEE_SOL_UNAVAILABLE_MESSAGE, faucetSuccessSchema } from "@/lib/faucet/response";

async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/faucet", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  claim.mockReset();
  create.mockReset();
  create.mockReturnValue({ claim });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/faucet", () => {
  it("returns the signature, the fixed amount and the fee SOL sent on success", async () => {
    claim.mockResolvedValue({
      status: 200,
      signature: "sig",
      amountBaseUnits: 1_000_000_000n,
      feeSol: { status: "sent", lamports: 10_000_000n },
    });
    const { POST } = await loadRoute();
    const response = await POST(post({ wallet: "A".repeat(44) }));
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      signature: "sig",
      amount_base_units: "1000000000",
      fee_sol_status: "sent",
      fee_sol_lamports: "10000000",
    });
    // The reply is exactly what the button and the demo wallet parse.
    expect(faucetSuccessSchema.parse(body)).toEqual(body);
    expect(claim).toHaveBeenCalledWith("A".repeat(44));
  });

  it("reports no fee SOL for a wallet that already has some", async () => {
    claim.mockResolvedValue({
      status: 200,
      signature: "sig",
      amountBaseUnits: 1n,
      feeSol: { status: "not_needed" },
    });
    const { POST } = await loadRoute();
    const body: unknown = await (await POST(post({ wallet: "A".repeat(44) }))).json();
    expect(body).toMatchObject({ fee_sol_status: "not_needed", fee_sol_lamports: "0" });
    expect(body).not.toHaveProperty("fee_sol_message");
  });

  it("still answers 200 with a clear message when the faucet is too low on SOL to send fees", async () => {
    claim.mockResolvedValue({
      status: 200,
      signature: "sig",
      amountBaseUnits: 1n,
      feeSol: { status: "faucet_low" },
    });
    const { POST } = await loadRoute();
    const response = await POST(post({ wallet: "A".repeat(44) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fee_sol_status: "faucet_low",
      fee_sol_lamports: "0",
      fee_sol_message: FEE_SOL_UNAVAILABLE_MESSAGE,
    });
  });

  it.each([
    [429, "already claimed"],
    [503, "out of funds"],
    [500, "misconfigured"],
    [502, "try again"],
  ])("passes a %i result through as the status", async (status, error) => {
    claim.mockResolvedValue({ status, error });
    const { POST } = await loadRoute();
    const response = await POST(post({ wallet: "A".repeat(44) }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("rejects a malformed body with 400 before touching the faucet", async () => {
    const { POST } = await loadRoute();
    for (const body of [
      "not json",
      {},
      { wallet: 5 },
      { wallet: "short" },
      { wallet: "x".repeat(45) },
    ]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("answers 500 without values when the environment is incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    create.mockImplementation(() => {
      throw new FaucetConfigError("FAUCET_KEYPAIR is not set");
    });
    const { POST } = await loadRoute();
    const response = await POST(post({ wallet: "A".repeat(44) }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The faucet is not configured." });
    expect(JSON.stringify(warn.mock.calls)).toContain("FAUCET_KEYPAIR is not set");
  });

  it("builds the faucet once and reuses it", async () => {
    claim.mockResolvedValue({
      status: 200,
      signature: "s",
      amountBaseUnits: 1n,
      feeSol: { status: "not_needed" },
    });
    const { POST } = await loadRoute();
    await POST(post({ wallet: "A".repeat(44) }));
    await POST(post({ wallet: "A".repeat(44) }));
    expect(create).toHaveBeenCalledTimes(1);
  });
});
