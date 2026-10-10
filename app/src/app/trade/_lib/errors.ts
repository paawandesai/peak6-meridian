/**
 * Plain-word failure text for the status line (design.md §3 "Transaction state"): the program's
 * own error message when the logs or the error code name one, otherwise a short generic reason.
 * The caller's line appends "Nothing was charged." itself.
 */
import { MERIDIAN_IDL } from "@meridian/client";

const BY_CODE = new Map<number, string>(
  (MERIDIAN_IDL.errors ?? []).map((error) => [error.code, error.msg ?? error.name]),
);

const SIMPLE: Record<string, string> = {
  InsufficientFundsForFee: "not enough devnet SOL to pay the network fee",
  AccountNotFound: "the wallet has no devnet SOL for the network fee",
  BlockhashNotFound: "the network did not accept the transaction in time; try again",
};

function strip(text: string): string {
  return text.trim().replace(/\.$/, "");
}

/** The most specific plain-words reason available for a failed simulation or send. */
export function txErrorText(
  err: unknown,
  logs: readonly string[] | null | undefined = null,
): string {
  for (const line of logs ?? []) {
    const anchor = /Error Message: (.+)$/.exec(line);
    if (anchor?.[1] !== undefined) return strip(anchor[1]);
  }
  if (typeof err === "string") return SIMPLE[err] ?? strip(err);
  if (err !== null && typeof err === "object" && "InstructionError" in err) {
    const detail = (err as { InstructionError: unknown }).InstructionError;
    const kind = Array.isArray(detail) ? (detail[1] as unknown) : undefined;
    if (kind !== null && typeof kind === "object" && "Custom" in kind) {
      const code = Number((kind as { Custom: unknown }).Custom);
      const known = BY_CODE.get(code);
      if (known !== undefined) return strip(known);
      for (const line of logs ?? []) {
        const token = /Program log: Error: (.+)$/.exec(line);
        if (token?.[1] !== undefined) return strip(token[1]);
      }
      return `the program rejected the order (error ${code})`;
    }
    if (typeof kind === "string")
      return strip(kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  }
  if (err instanceof Error && err.message.trim() !== "") return strip(err.message);
  return "the transaction could not be completed";
}
