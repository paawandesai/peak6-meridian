import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";

import { readKeypairFile } from "./keypair";

const dir = mkdtempSync(join(tmpdir(), "keypair-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("readKeypairFile", () => {
  it("reads a valid keypair file", () => {
    const keypair = Keypair.generate();
    const path = write("ok.json", JSON.stringify(Array.from(keypair.secretKey)));
    expect(readKeypairFile(path).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects bad files without echoing their contents", () => {
    const secretish = JSON.stringify(Array.from({ length: 64 }, () => 7));
    const cases: [string, string, RegExp][] = [
      ["not-json.json", "not json at all 12345", /not JSON/],
      ["short.json", JSON.stringify([1, 2, 3]), /64 bytes/],
      ["range.json", JSON.stringify(Array.from({ length: 64 }, () => 300)), /64 bytes/],
      // 64 valid bytes whose public half does not match the secret half
      ["mismatch.json", secretish, /valid ed25519 keypair/],
    ];
    for (const [name, content, pattern] of cases) {
      const path = write(name, content);
      let message = "";
      try {
        readKeypairFile(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain("12345");
      expect(message).not.toContain("7,7,7");
    }
  });

  it("reports an unreadable file by path and error code only", () => {
    expect(() => readKeypairFile(join(dir, "missing.json"))).toThrow(
      /cannot read keypair file .*ENOENT/,
    );
  });
});
