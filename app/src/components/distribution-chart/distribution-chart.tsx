"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { type DistributionPoint, violations } from "./distribution";
import { edgeCents, edgeText } from "@/lib/fair-values";
import { formatStrike } from "@/lib/markets";

const cents = (value: number | null): string => (value === null ? "—" : `${value}¢`);

/**
 * The ticker's implied distribution: YES price (= P(close ≥ K)) by strike, with the fair value
 * alongside where the service priced it. The chart is an image for sighted users; the table below
 * is its text alternative and carries every number (NFR-16). A ladder where YES rises with the
 * strike is shown as a written inconsistency, never smoothed.
 */
export function DistributionChart({
  ticker,
  points,
}: {
  readonly ticker: string;
  readonly points: readonly DistributionPoint[];
}) {
  if (points.length === 0) return null;
  const broken = violations(points);
  const data = points.map((point) => ({
    strike: formatStrike(point.strikeCents),
    market: point.yesCents,
    fair: point.fairCents,
  }));
  return (
    <figure className="grid gap-mer-3" aria-labelledby="dist-title">
      <figcaption id="dist-title" className="text-mer-lg font-semibold">
        Implied distribution: {ticker}
      </figcaption>
      <p className="text-mer-sm text-mer-ink-muted">
        Each strike&apos;s YES price is the market&apos;s chance that {ticker} closes at or above
        it. The table has the same numbers.
      </p>
      <div
        role="img"
        aria-label={`Line chart of the YES price in cents by strike for ${ticker}. The table below has the same data.`}
        className="h-56 w-full"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 480, height: 224 }}
        >
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mer-rule)" />
            <XAxis dataKey="strike" tick={{ fill: "var(--mer-ink-muted)", fontSize: 12 }} />
            <YAxis
              domain={[0, 100]}
              unit="¢"
              tick={{ fill: "var(--mer-ink-muted)", fontSize: 12 }}
            />
            <Tooltip />
            <Legend />
            <Line
              type="linear"
              dataKey="market"
              name="Market YES"
              stroke="var(--mer-yes)"
              strokeWidth={2}
              dot
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="fair"
              name="Fair YES"
              stroke="var(--mer-ink)"
              strokeDasharray="5 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {broken.length === 0 ? null : (
        <ul
          className="grid gap-mer-1 text-mer-sm text-mer-warn"
          aria-label="Ladder inconsistencies"
        >
          {broken.map((v) => (
            <li key={`${v.lowerStrikeCents}-${v.higherStrikeCents}`}>
              Ladder inconsistency: {formatStrike(v.higherStrikeCents)} YES is {v.higherYesCents}¢,
              above {formatStrike(v.lowerStrikeCents)} YES at {v.lowerYesCents}¢ (a higher strike
              should not cost more).
            </li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-mer-sm" data-testid="distribution-table">
          <caption className="pb-mer-1 text-left text-mer-xs text-mer-ink-muted">
            YES price, fair value and edge by strike
          </caption>
          <thead>
            <tr className="text-left text-mer-ink-muted">
              <th scope="col" className="py-0.5 font-medium">
                Strike
              </th>
              <th scope="col" className="py-0.5 font-medium">
                Market YES
              </th>
              <th scope="col" className="py-0.5 font-medium">
                Fair YES
              </th>
              <th scope="col" className="py-0.5 font-medium">
                Edge
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.market}>
                <th scope="row" className="py-0.5 text-left font-normal">
                  {formatStrike(point.strikeCents)}
                </th>
                <td className="mer-num py-0.5">{cents(point.yesCents)}</td>
                <td className="mer-num py-0.5">{cents(point.fairCents)}</td>
                <td className="py-0.5">
                  {point.yesCents === null || point.fairCents === null
                    ? "—"
                    : edgeText(edgeCents(point.yesCents, point.fairCents))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
