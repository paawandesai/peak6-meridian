/** Name of the on-chain program this client targets. */
export const PROGRAM_NAME = "meridian";

/**
 * Package identity.
 *
 * M1-01 placeholder: the generated Anchor client, PDA helpers and unit conversions arrive
 * with M1-02.
 */
export function clientInfo(): { readonly name: string; readonly program: string } {
  return { name: "@meridian/client", program: PROGRAM_NAME };
}
