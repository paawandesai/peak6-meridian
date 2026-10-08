/**
 * Shared wallet event decoder (M2-05). Turns a transaction's log messages into typed program
 * events using the generated client's event parser. M2-07 (Portfolio P&L) and M2-08 (History)
 * import this; neither duplicates decoder logic. Unknown or malformed events are skipped, never
 * thrown, so one bad log line cannot break a page.
 */
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { MERIDIAN_IDL, symbolFromBytes } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";

export type TradeSide = "Bid" | "Ask";

type Base = {
  /** Base58 transaction signature (for the devnet explorer link). */
  readonly signature: string;
  /** Block time, unix seconds; `null` when the cluster has not reported one. */
  readonly blockTime: number | null;
};

export type MeridianEvent = Base &
  (
    | {
        readonly kind: "Fill";
        readonly market: string;
        readonly maker: string;
        readonly taker: string;
        readonly price: number;
        readonly qty: bigint;
        readonly takerSide: TradeSide;
      }
    | {
        readonly kind: "OrderPlaced";
        readonly market: string;
        readonly owner: string;
        readonly orderId: bigint;
        readonly side: TradeSide;
        readonly price: number;
        readonly qty: bigint;
        readonly restedQty: bigint;
      }
    | {
        readonly kind: "OrderCancelled";
        readonly market: string;
        readonly owner: string;
        readonly orderId: bigint;
        readonly qty: bigint;
      }
    | {
        readonly kind: "PairsMinted";
        readonly market: string;
        readonly user: string;
        readonly qty: bigint;
        readonly pairsOutstanding: bigint;
      }
    | {
        readonly kind: "Redeemed";
        readonly market: string;
        readonly user: string;
        readonly yesQty: bigint;
        readonly noQty: bigint;
        readonly usdc: bigint;
      }
    | {
        readonly kind: "FundsSettled";
        readonly market: string;
        readonly owner: string;
        readonly usdc: bigint;
        readonly yes: bigint;
      }
    | {
        readonly kind: "MarketCreated";
        readonly market: string;
        readonly ticker: string;
        readonly strikeCents: bigint;
        readonly tradingDate: number;
        readonly closeTs: bigint;
      }
    | {
        readonly kind: "MarketSettled";
        readonly market: string;
        readonly outcome: "Yes" | "No";
        readonly oracleSlot: bigint;
      }
  );

const DATA_PREFIX = "Program data: ";

export type EventKind = MeridianEvent["kind"];

/** Event kinds this decoder returns (others, e.g. config and pause events, are not wallet events). */
export const WALLET_EVENT_KINDS: readonly EventKind[] = [
  "Fill",
  "OrderPlaced",
  "OrderCancelled",
  "PairsMinted",
  "Redeemed",
  "FundsSettled",
  "MarketCreated",
  "MarketSettled",
];

type AnchorValue = { toString(): string };
type RawEvent = { name: string; data: Record<string, unknown> };

const str = (value: unknown): string => {
  if (value !== null && typeof value === "object" && "toBase58" in value) {
    return (value as PublicKey).toBase58();
  }
  throw new Error("not a public key");
};
const big = (value: unknown): bigint => BigInt((value as AnchorValue).toString());
const num = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("not an integer");
  return value;
};
/** An Anchor enum value `{ bid: {} }` → "Bid". */
const variant = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  const key = Object.keys(value as object)[0];
  const match = allowed.find((name) => name.toLowerCase() === key?.toLowerCase());
  if (match === undefined) throw new Error("unknown variant");
  return match;
};

/** Anchor's event coder returns the IDL's snake_case field names; the rest of the app uses camelCase. */
function camelKeys(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function convert(raw: RawEvent, base: Base): MeridianEvent | null {
  const d = camelKeys(raw.data);
  switch (raw.name) {
    case "Fill":
      return {
        ...base,
        kind: "Fill",
        market: str(d.market),
        maker: str(d.maker),
        taker: str(d.taker),
        price: num(d.price),
        qty: big(d.qty),
        takerSide: variant(d.takerSide, ["Bid", "Ask"] as const),
      };
    case "OrderPlaced":
      return {
        ...base,
        kind: "OrderPlaced",
        market: str(d.market),
        owner: str(d.owner),
        orderId: big(d.orderId),
        side: variant(d.side, ["Bid", "Ask"] as const),
        price: num(d.price),
        qty: big(d.qty),
        restedQty: big(d.restedQty),
      };
    case "OrderCancelled":
      return {
        ...base,
        kind: "OrderCancelled",
        market: str(d.market),
        owner: str(d.owner),
        orderId: big(d.orderId),
        qty: big(d.qty),
      };
    case "PairsMinted":
      return {
        ...base,
        kind: "PairsMinted",
        market: str(d.market),
        user: str(d.user),
        qty: big(d.qty),
        pairsOutstanding: big(d.pairsOutstanding),
      };
    case "Redeemed":
      return {
        ...base,
        kind: "Redeemed",
        market: str(d.market),
        user: str(d.user),
        yesQty: big(d.yesQty),
        noQty: big(d.noQty),
        usdc: big(d.usdc),
      };
    case "FundsSettled":
      return {
        ...base,
        kind: "FundsSettled",
        market: str(d.market),
        owner: str(d.owner),
        usdc: big(d.usdc),
        yes: big(d.yes),
      };
    case "MarketCreated":
      return {
        ...base,
        kind: "MarketCreated",
        market: str(d.market),
        ticker: symbolFromBytes(d.ticker as ArrayLike<number>),
        strikeCents: big(d.strikeCents),
        tradingDate: num(d.tradingDate),
        closeTs: big(d.closeTs),
      };
    case "MarketSettled":
      return {
        ...base,
        kind: "MarketSettled",
        market: str(d.market),
        outcome: variant(d.outcome, ["Yes", "No"] as const),
        oracleSlot: big(d.oracleSlot),
      };
    default:
      return null;
  }
}

/**
 * Decodes the program events in `logs` (the `meta.logMessages` of one transaction).
 * `programId` defaults to the IDL address; pass the deployment's ID for devnet. Events that do
 * not belong to the wallet feed (config, pause) and anything undecodable are skipped.
 */
export function decodeEvents(
  logs: readonly string[],
  context: { readonly signature: string; readonly blockTime?: number | null },
  programId: PublicKey | string = MERIDIAN_IDL.address,
): MeridianEvent[] {
  const base: Base = { signature: context.signature, blockTime: context.blockTime ?? null };
  const coder = new BorshCoder(MERIDIAN_IDL);
  const parser = new EventParser(
    typeof programId === "string" ? new PublicKey(programId) : programId,
    coder,
  );
  // Drop `Program data:` lines that cannot be decoded: an event that throws inside `parseLogs`
  // would otherwise end decoding for the rest of the transaction. Unknown discriminators decode
  // to null and are left for the parser to skip.
  const decodable = logs.filter((line) => {
    if (!line.startsWith(DATA_PREFIX)) return true;
    try {
      const body = Buffer.from(line.slice(DATA_PREFIX.length), "base64");
      const decoded = coder.events.decode(line.slice(DATA_PREFIX.length));
      if (decoded === null) return true;
      // A short body can decode into zero-filled garbage instead of throwing, so require the
      // decoded value to re-encode to exactly the bytes that were logged.
      return coder.types.encode(decoded.name, decoded.data).length === body.length - 8;
    } catch {
      return false;
    }
  });
  const out: MeridianEvent[] = [];
  try {
    for (const raw of parser.parseLogs(decodable)) {
      try {
        const event = convert(raw as RawEvent, base);
        if (event !== null) out.push(event);
      } catch {
        // malformed field in a known event: skip it, keep the rest
      }
    }
  } catch {
    // an unparsable log stream yields whatever was decoded before it
  }
  return out;
}
