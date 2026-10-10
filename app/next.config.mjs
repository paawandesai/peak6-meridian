import { readFileSync } from "node:fs";

/**
 * The committed demo-session registry (`deployments/demo-sessions.json`), inlined at build time
 * so every page can label demo markets with their simulated date. It is public, committed data
 * (no secrets). Missing file → empty registry; unparseable JSON fails the build loudly. The app
 * validates the shape with zod (`src/lib/demo-session.ts`).
 */
function demoSessionsText() {
  let text;
  try {
    text = readFileSync(new URL("../deployments/demo-sessions.json", import.meta.url), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
  return JSON.stringify(JSON.parse(text));
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @meridian/client ships TypeScript source (no build step).
  transpilePackages: ["@meridian/client"],
  env: { NEXT_PUBLIC_DEMO_SESSIONS: demoSessionsText() },
};

export default nextConfig;
