"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  type BookLevels,
  changedLevels,
  depthPercent,
  derivedNoLine,
  type FullBook,
  type LevelKey,
  levelKey,
  levelsOf,
  noView,
  spreadOf,
  yesKeyOfNoRow,
} from "../_lib/book-view";

const DEPTH = 6;
/** How long a level that changed (a fill, a new or cancelled order) stays highlighted. */
export const HIGHLIGHT_MS = 2_000;

export const NO_VIEW_CAPTION =
  "NO view: YES asks are shown as NO bids at 100 − p, and YES bids as NO asks at 100 − p.";
export const YES_VIEW_CAPTION = "YES view: resting orders for YES, priced in cents.";
export const CHANGED_TEXT = "changed";

type View = "YES" | "NO";

function Rows({
  side,
  levels,
  label,
  view,
  maxQty,
  flash,
}: {
  readonly side: "ask" | "bid";
  readonly levels: BookLevels["asks"];
  readonly label: string;
  readonly view: View;
  readonly maxQty: bigint;
  readonly flash: ReadonlySet<LevelKey>;
}) {
  const bar = view === "YES" ? "bg-mer-yes/15" : "bg-mer-no/15";
  return levels.map((level) => {
    // Highlights are kept in YES terms so both views mark the same level of the one book.
    const yesKey = view === "YES" ? levelKey(side, level.price) : yesKeyOfNoRow(side, level.price);
    const changed = flash.has(yesKey);
    return (
      <tr
        key={`${side}-${level.price}`}
        data-side={side}
        data-yes-level={yesKey}
        data-changed={changed ? "true" : undefined}
        className={changed ? "bg-mer-warn/15 outline outline-1 outline-mer-warn" : undefined}
      >
        <th scope="row" className="py-0.5 pr-mer-3 text-left font-normal text-mer-ink-muted">
          {label}
        </th>
        <td className="mer-num py-0.5 pr-mer-3 text-right">{level.price}¢</td>
        <td className="mer-num relative py-0.5 text-right">
          <span
            aria-hidden="true"
            data-testid="depth-bar"
            className={`absolute inset-y-0.5 right-0 rounded-sm ${bar}`}
            style={{ width: `${depthPercent(level.qty, maxQty)}%` }}
          />
          <span className="relative">×{level.qty.toString()}</span>
          {changed ? (
            <span className="relative ml-mer-1 text-mer-xs font-semibold text-mer-warn">
              {CHANGED_TEXT}
            </span>
          ) : null}
        </td>
      </tr>
    );
  });
}

/**
 * The YES-terms levels that changed on the latest read, held for {@link HIGHLIGHT_MS}. A later
 * read with no change keeps the running highlight; a new change restarts it.
 */
function useFlash(levels: BookLevels | null): ReadonlySet<LevelKey> {
  const previous = useRef<BookLevels | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flash, setFlash] = useState<ReadonlySet<LevelKey>>(() => new Set());
  useEffect(() => {
    if (levels === null) return;
    const before = previous.current;
    previous.current = levels;
    if (before === null) return;
    const changed = changedLevels(before, levels);
    if (changed.length === 0) return;
    setFlash(new Set(changed));
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setFlash(new Set());
    }, HIGHLIGHT_MS);
  }, [levels]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return flash;
}

/**
 * The book with a YES / NO view toggle (US-08, design.md §5 Trade): one book, relabelled. Depth
 * bars show each level's size; a level that changes is highlighted in both views for 2 s, so the
 * toggle shows the same fill. Read-only in every market state.
 */
export function BookPanel({ book }: { readonly book: FullBook | null }) {
  const [view, setView] = useState<View>("YES");
  const yesLevels = useMemo(() => (book === null ? null : levelsOf(book)), [book]);
  const flash = useFlash(yesLevels);
  if (yesLevels === null) return <p role="status">Loading the book…</p>;
  const levels = view === "YES" ? yesLevels : noView(yesLevels);
  const asks = [...levels.asks].slice(0, DEPTH).reverse();
  const bids = levels.bids.slice(0, DEPTH);
  const maxQty = [...asks, ...bids].reduce((max, level) => (level.qty > max ? level.qty : max), 0n);
  const spread = spreadOf(levels);
  const yesMid = spreadOf(yesLevels).mid;
  const tab = (value: View) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={view === value}
      onClick={() => setView(value)}
      className={`min-h-9 rounded-mer border border-mer-control-border px-mer-3 py-mer-1 text-mer-sm font-semibold ${
        view === value ? "bg-mer-ink text-mer-paper" : "bg-mer-surface text-mer-ink"
      }`}
    >
      {value} view
    </button>
  );
  const empty = levels.asks.length === 0 && levels.bids.length === 0;
  return (
    <section aria-labelledby="book-heading" className="grid gap-mer-3" data-view={view}>
      <div className="flex items-center justify-between gap-mer-3">
        <h2 id="book-heading" className="text-mer-lg font-semibold">
          Book
        </h2>
        <div role="radiogroup" aria-label="Book view" className="flex gap-mer-2">
          {tab("YES")}
          {tab("NO")}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-mer-sm" data-testid="book-table">
          <caption className="pb-mer-2 text-left text-mer-xs text-mer-ink-muted">
            <span className="block">{view === "NO" ? NO_VIEW_CAPTION : YES_VIEW_CAPTION}</span>
            <span data-testid="derived-no" className="mt-mer-1 block font-medium text-mer-ink">
              {derivedNoLine(yesMid)}
            </span>
          </caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Price</th>
              <th scope="col">Contracts</th>
            </tr>
          </thead>
          <tbody>
            <Rows
              side="ask"
              levels={asks}
              label={view === "NO" ? "NO asks" : "Asks"}
              view={view}
              maxQty={maxQty}
              flash={flash}
            />
            <tr aria-label="spread">
              <td
                colSpan={3}
                className="border-y border-mer-rule py-mer-1 text-center text-mer-xs text-mer-ink-muted"
              >
                {empty
                  ? "No resting orders"
                  : spread.spread === null || spread.mid === null
                    ? "no spread: one side is empty"
                    : `spread ${spread.spread}¢ · mid ${spread.mid}¢`}
              </td>
            </tr>
            <Rows
              side="bid"
              levels={bids}
              label={view === "NO" ? "NO bids" : "Bids"}
              view={view}
              maxQty={maxQty}
              flash={flash}
            />
          </tbody>
        </table>
      </div>
      <p className="text-mer-xs text-mer-ink-muted">
        Bars show each level&apos;s size. A level that just changed (a fill, a new or cancelled
        order) is marked &quot;{CHANGED_TEXT}&quot; for 2 s in both views.
      </p>
    </section>
  );
}
