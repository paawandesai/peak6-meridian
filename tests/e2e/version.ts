// E2E placeholder (M1-01, replaced by the lifecycle smoke in M1-10): calls the deployed
// program's `version` instruction and checks that it logged the crate version.
// Run by scripts/e2e.sh with ANCHOR_PROVIDER_URL and ANCHOR_WALLET set.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { z } from "zod";

const IDL_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../target/idl/meridian.json",
);

const idlSchema = z.looseObject({
  address: z.string().min(32),
  metadata: z.looseObject({ name: z.literal("meridian"), version: z.string().min(1) }),
  instructions: z.array(z.looseObject({ name: z.string() })),
});

async function main(): Promise<void> {
  const idl = idlSchema.parse(JSON.parse(readFileSync(IDL_PATH, "utf8")));
  if (!idl.instructions.some((instruction) => instruction.name === "version")) {
    throw new Error(`IDL at ${IDL_PATH} has no "version" instruction`);
  }

  const provider = AnchorProvider.env();
  const program = new Program(idl as unknown as Idl, provider);
  const version = program.methods.version;
  if (version === undefined) {
    throw new Error('generated client has no "version" method');
  }

  const signature = await version().rpc({ commitment: "confirmed" });
  const tx = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  const expected = `Program log: meridian ${idl.metadata.version}`;
  if (tx?.meta?.err != null || !logs.includes(expected)) {
    throw new Error(
      `version call ${signature} did not log ${JSON.stringify(expected)}; logs: ${JSON.stringify(logs)}`,
    );
  }
  console.log(`e2e ok: program ${idl.address} logged "${expected}" (tx ${signature})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
