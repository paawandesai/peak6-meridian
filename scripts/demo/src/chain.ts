/**
 * The Anchor/RPC shell of the demo CLIs: cluster guard, program handle and the chain adapters
 * behind `DemoMarketChain` and `DemoSettleChain`. The logic they serve is unit-tested with
 * fakes; this file is exercised by running the tools.
 */
import { AnchorProvider, type Program, utils, Wallet } from "@coral-xyz/anchor";
import {
  assertCluster,
  BN,
  type ClusterName,
  createMeridianProgram,
  findConfigPda,
  isLoopbackUrl,
  type Meridian,
  MERIDIAN_PROGRAM_ID,
  redactRpcUrl,
  symbolFromBytes,
} from "@meridian/client";
import { chainMarketOps } from "automation";
import { Connection, type Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { type DemoMarketChain } from "./markets";
import { type DemoOpenMarket, type DemoSettleChain } from "./settle";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Byte offset of `Market.trading_date`: discriminator 8 + ticker 8 + strike_cents 8. */
const TRADING_DATE_OFFSET = 24;

export interface ProgramHandle {
  readonly program: Program<Meridian>;
  readonly cluster: ClusterName;
  readonly rpcUrl: string;
}

/**
 * Connects and refuses anything but devnet (by genesis hash) or a loopback local validator.
 * `signer` pays and signs; a DRY_RUN passes any keypair (nothing is sent).
 */
export async function connectProgram(params: {
  readonly rpcUrl: string;
  readonly programId?: string | undefined;
  readonly signer: Keypair;
}): Promise<ProgramHandle> {
  const connection = new Connection(params.rpcUrl, "confirmed");
  const cluster = await assertCluster({
    cluster: isLoopbackUrl(params.rpcUrl) ? "localnet" : "devnet",
    rpcUrl: params.rpcUrl,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  const provider = new AnchorProvider(connection, new Wallet(params.signer), {
    commitment: "confirmed",
  });
  const programId =
    params.programId === undefined ? MERIDIAN_PROGRAM_ID : new PublicKey(params.programId);
  return { program: createMeridianProgram(provider, programId), cluster, rpcUrl: params.rpcUrl };
}

/** Config's automation authority and admin, base58. */
export async function configKeys(
  program: Program<Meridian>,
): Promise<{ automationAuthority: string; admin: string }> {
  const config = await program.account.config.fetch(findConfigPda(program.programId).address);
  return {
    automationAuthority: config.automationAuthority.toBase58(),
    admin: config.admin.toBase58(),
  };
}

export async function demoMarketChain(
  program: Program<Meridian>,
  create: boolean,
): Promise<DemoMarketChain> {
  return {
    async marketsOnDate(tradingDate) {
      return (await marketsOn(program, tradingDate)).map(({ account }) => ({
        ticker: symbolFromBytes(account.ticker),
        strikeCents: BigInt(account.strikeCents.toString()),
        closeTs: Number(account.closeTs.toString()),
      }));
    },
    marketOps: create
      ? await chainMarketOps(program, TOKEN_PROGRAM_ID, SystemProgram.programId)
      : undefined,
  };
}

/** Market accounts whose `trading_date` is `tradingDate`, by a memcmp filter (one RPC call). */
async function marketsOn(program: Program<Meridian>, tradingDate: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(tradingDate);
  const all = await program.account.market.all([
    { memcmp: { offset: TRADING_DATE_OFFSET, bytes: utils.bytes.bs58.encode(bytes) } },
  ]);
  // Belt and braces: the decoded field must match the filter.
  return all.filter(({ account }) => account.tradingDate === tradingDate);
}

export function demoSettleChain(program: Program<Meridian>, send: boolean): DemoSettleChain {
  const config = findConfigPda(program.programId).address;
  return {
    async config() {
      const account = await program.account.config.fetch(config);
      return {
        admin: account.admin.toBase58(),
        overrideDelaySecs: Number(account.overrideDelaySecs.toString()),
      };
    },
    async openMarkets(tradingDate) {
      const open: DemoOpenMarket[] = [];
      for (const { publicKey, account } of await marketsOn(program, tradingDate)) {
        if ("open" in account.status) {
          open.push({
            address: publicKey.toBase58(),
            ticker: symbolFromBytes(account.ticker),
            strikeCents: BigInt(account.strikeCents.toString()),
            closeTs: Number(account.closeTs.toString()),
          });
        }
      }
      return open.sort(
        (a, b) =>
          a.ticker.localeCompare(b.ticker) ||
          (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0),
      );
    },
    settle: send
      ? (market, priceCents) =>
          program.methods
            .adminSettleOverride(new BN(priceCents.toString()))
            .accountsStrict({
              config,
              market: new PublicKey(market.address),
              admin: program.provider.publicKey ?? PublicKey.default,
            })
            .rpc({ commitment: "confirmed" })
      : undefined,
  };
}

/** An error message with the RPC URL (and any other URL) removed. */
export function safeMessage(error: unknown, rpcUrl: string | undefined): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactRpcUrl(text, rpcUrl ?? "");
}
