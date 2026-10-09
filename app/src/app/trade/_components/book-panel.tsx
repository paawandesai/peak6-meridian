"use client";

import { useState } from "react";

import {
  type BookLevels,
  derivedNoLine,
  type FullBook,
  levelsOf,
  noView,
  spreadOf,
} from "../_lib/book-view";

const DEPTH = 6;

export const NO_VIEW_CAPTION =
  "NO view: YES asks are shown as NO bids at 100 − p, and YES bids as NO asks at 100 − p.";
export const YES_VIEW_CAPTION = "YES view: resting orders for YES, priced in cents.";

function Rows({
  side,
  levels,
  label,
}: {
  readonly side: "ask" | "bid";
  readonly levels: BookLevels["asks"];
  readonly label: string;
}) {
  return levels.slice(0, DEPTH).map((level) => (
    <tr key={`${side}-${level.price}`} data-side={side}>
      <th scope="row" className="py-0.5 pr-mer-3 text-left font-normal text-mer-ink-muted">
        {label}
      </th>
      <td className="mer-num py-0.5 pr-mer-3 text-right">{level.price}¢</td>
      <td className="mer-num py-0.5 text-right">×{level.qty.toString()}</td>
    </tr>
  ));
}

/** The book with a YES / NO view toggle (design.md §5 Trade). Read-only in every market state. */
export function BookPanel({ book }: { readonly book: FullBook | null }) {
  const [view, setView] = useState<"YES" | "NO">("YES");
  if (book === null) return <p role="status">Loading the book…</p>;
  const yesLevels = levelsOf(book);
  const levels = view === "YES" ? yesLevels : noView(yesLevels);
  const spread = spreadOf(levels);
  const yesMid = spreadOf(yesLevels).mid;
  const tab = (value: "YES" | "NO") => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={view === value}
      onClick={() => setView(value)}
      className={`rounded-mer border border-mer-control-border px-mer-3 py-mer-1 text-mer-sm font-semibold ${
        view === value ? "bg-mer-ink text-mer-paper" : "bg-mer-surface text-mer-ink"
      }`}
    >
      {value} view
    </button>
  );
  const empty = levels.asks.length === 0 && levels.bids.length === 0;
  return (
    <section aria-labelledby="book-heading" className="grid gap-mer-3">
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
            {view === "NO" ? NO_VIEW_CAPTION : YES_VIEW_CAPTION}
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
              levels={[...levels.asks].slice(0, DEPTH).reverse()}
              label={view === "NO" ? "NO asks" : "Asks"}
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
            <Rows side="bid" levels={levels.bids} label={view === "NO" ? "NO bids" : "Bids"} />
          </tbody>
        </table>
      </div>
      <p className="text-mer-xs text-mer-ink-muted" data-testid="derived-no">
        {derivedNoLine(yesMid)}
      </p>
    </section>
  );
}
