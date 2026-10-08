/**
 * Rejecting a draft hides it on this browser: the ops-agent contract has no reject call (M3-05
 * owns the service), and a rejection signs nothing and changes nothing on chain. The ids are kept
 * in localStorage so a reload does not bring a rejected draft back; the draft stays pending in
 * the service until the market settles.
 */
const KEY = "meridian.admin.rejected-drafts";

export function loadRejected(storage: Pick<Storage, "getItem"> | undefined): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveRejected(
  storage: Pick<Storage, "setItem"> | undefined,
  ids: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // storage unavailable (private mode): the rejection still holds for this page view
  }
}
