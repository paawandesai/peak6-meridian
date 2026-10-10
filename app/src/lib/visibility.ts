/**
 * Page visibility for the client pollers (P0-4, P1-2): a hidden tab skips timed polls and catches
 * up once it is shown again. Outside a browser (SSR, node tests) the page counts as visible.
 */

/** `false` only while the document reports `hidden`. */
export function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Calls `listener` each time the document becomes visible; returns the unsubscribe. */
export function onDocumentVisible(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = (): void => {
    if (isDocumentVisible()) listener();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
