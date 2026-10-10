import { describe, expect, it } from "vitest";

import { txErrorText } from "./errors";

describe("txErrorText", () => {
  it("prefers the program's own error message from the logs", () => {
    expect(
      txErrorText({ InstructionError: [1, { Custom: 6015 }] }, [
        "Program log: AnchorError thrown in programs/meridian/src/x.rs:1. Error Code: MarketClosed. Error Number: 6015. Error Message: Market is closed: no minting or new orders at or after close_ts.",
      ]),
    ).toBe("Market is closed: no minting or new orders at or after close_ts");
  });

  it("falls back to the IDL message for a custom code", () => {
    expect(txErrorText({ InstructionError: [0, { Custom: 6016 }] })).toBe(
      "Trading is paused: no minting or new orders",
    );
  });

  it("uses the token program's own log for unknown custom codes, else the code", () => {
    expect(
      txErrorText({ InstructionError: [1, { Custom: 1 }] }, [
        "Program log: Error: insufficient funds",
      ]),
    ).toBe("insufficient funds");
    expect(txErrorText({ InstructionError: [1, { Custom: 1 }] })).toBe(
      "the program rejected the order (error 1)",
    );
  });

  it("names plain cluster errors in words", () => {
    expect(txErrorText("InsufficientFundsForFee")).toMatch(/devnet SOL/);
    expect(txErrorText("AccountNotFound")).toMatch(/no devnet SOL/);
    expect(txErrorText("SomethingElse.")).toBe("SomethingElse");
  });

  it("turns a named instruction error into words", () => {
    expect(txErrorText({ InstructionError: [0, "InvalidAccountData"] })).toBe(
      "invalid account data",
    );
  });

  it("handles an Error object and unknown shapes", () => {
    expect(txErrorText(new Error("User rejected the request."))).toBe("User rejected the request");
    expect(txErrorText({ weird: true })).toBe("the transaction could not be completed");
    expect(txErrorText(null)).toBe("the transaction could not be completed");
  });
});
