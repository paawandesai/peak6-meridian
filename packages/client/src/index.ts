/** Name of the on-chain program this client targets. */
export const PROGRAM_NAME = "meridian";

/** Package identity. */
export function clientInfo(): { readonly name: string; readonly program: string } {
  return { name: "@meridian/client", program: PROGRAM_NAME };
}

export * from "./bn";
export * from "./book";
export * from "./calendar";
export * from "./cluster";
export * from "./config";
export * from "./demo-sessions";
export * from "./intents";
export type { Meridian } from "./idl/meridian";
export * from "./pda";
export * from "./program";
export * from "./units";
