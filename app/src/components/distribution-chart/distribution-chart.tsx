"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  type DistributionBucket,
  distributionBuckets,
  type DistributionPoint,
  violations,
} from "./distribution";
import { EdgeLabel, fairDetail, StaleTag } from "@/components/fair-value/fair-edge";
import { edgeCents } from "@/lib/fair-values";
import { formatStrike } from "@/lib/markets";

const cents = (value: number | null): string => (value === null ? "—" : `${value}¢`);
const percent = (value: number | null): string => (value === null ? "—" : `${value}%`);

/** `<$170`, `$170–180`, `≥$190`: the close lands in [lower, upper). */
export function bucketLabel(
  bucket: Pick<DistributionBucket, "lowerStrikeCents" | "upperStrikeCents">,
): string {
  const { lowerStrikeCents: lo, upperStrikeCents: hi } = bucket;
  if (lo === null) return hi === null ? "all" : `<${formatStrike(hi)}`;
  if (hi === null) return `≥${formatStrike(lo)}`;
  return `${formatStrike(lo)}–${formatStrike(hi).slice(1)}`;
}

/** Spoken form of {@link bucketLabel} for the table. */
function bucketWords(bucket: DistributionBucket): string {
  const { lowerStrikeCents: lo, upperStrikeCents: hi } = bucket;
  if (lo === null) return hi === null ? "any close" : `below ${formatStrike(hi)}`;
  if (hi === null) return `${formatStrike(lo)} or above`;
  return `${formatStrike(lo)} to below ${formatStrike(hi)}`;
}

function FairCell({
  point,
  nowSecs,
}: {
  readonly point: DistributionPoint;
  readonly nowSecs: number;
}) {
  if (point.fairCents === null) return <>—</>;
  if (point.fairStale !== true) return <>{cents(point.fairCents)}</>;
  const asOf = point.fairAsOfSecs ?? null;
  const reasons = point.fairStaleReasons ?? [];
  return (
    <span className="text-mer-ink-muted">
      {cents(point.fairCents)}
      <StaleTag
        detail={
          asOf === null
            ? "Fair value is the service's last one"
            : fairDetail(asOf, reasons, nowSecs)
        }
      />
    </span>
  );
}

/**
 * The ticker's implied distribution: the market's chance of the close landing between adjacent
 * strikes (bars), from the ladder's YES prices read as P(close ≥ K), with the same from the fair
 * values as a line. The chart is an image for sighted users; the tables are its text alternative
 * and carry every number (NFR-16). A ladder where YES rises with the strike is listed in words;
 * the bars come from a monotone-corrected copy so no range is negative, and that is said.
 */
export function DistributionChart({
  ticker,
  points,
  nowSecs,
}: {
  readonly ticker: string;
  readonly points: readonly DistributionPoint[];
  readonly nowSecs: number;
}) {
  if (points.length === 0) return null;
  const broken = violations(points);
  const buckets = distributionBuckets(points);
  const anyStale = points.some((point) => point.fairCents !== null && point.fairStale === true);
  const data = buckets.map((bucket) => ({
    range: bucketLabel(bucket),
    market: bucket.marketPercent,
    fair: bucket.fairPercent,
  }));
  const titleId = `dist-title-${ticker}`;
  return (
    <figure className="grid min-w-0 gap-mer-3" aria-labelledby={titleId}>
      <figcaption id={titleId} className="text-mer-lg font-semibold">
        Implied distribution: {ticker}
      </figcaption>
      <p className="text-mer-sm text-mer-ink-muted">
        Bars: the market&apos;s chance {ticker} closes in each range, from adjacent strikes&apos;
        YES prices (one strike&apos;s YES minus the next). Line: the same from the fair values. The
        tables have the same numbers.
      </p>
      <div
        role="img"
        aria-label={`Bar chart of the market-implied chance, in percent, that ${ticker} closes in each strike range, with the fair-value distribution as a line. The tables below have the same data.`}
        className="h-56 w-full min-w-0"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 480, height: 224 }}
        >
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mer-rule)" />
            <XAxis dataKey="range" tick={{ fill: "var(--mer-ink-muted)", fontSize: 11 }} />
            <YAxis
              unit="%"
              allowDecimals={false}
              tick={{ fill: "var(--mer-ink-muted)", fontSize: 11 }}
            />
            <Tooltip formatter={(value) => `${String(value)}%`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="market"
              name="Market"
              fill="var(--mer-yes)"
              fillOpacity={0.75}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="fair"
              name={anyStale ? "Fair value (stale)" : "Fair value"}
              stroke="var(--mer-ink)"
              strokeDasharray={anyStale ? "2 3" : "5 4"}
              strokeWidth={2}
              dot
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {broken.length === 0 ? null : (
        <div className="grid gap-mer-1 text-mer-sm text-mer-warn">
          <ul className="grid gap-mer-1" aria-label="Ladder inconsistencies">
            {broken.map((v) => (
              <li key={`${v.lowerStrikeCents}-${v.higherStrikeCents}`}>
                Ladder inconsistency: {formatStrike(v.higherStrikeCents)} YES is {v.higherYesCents}
                ¢, above {formatStrike(v.lowerStrikeCents)} YES at {v.lowerYesCents}¢ (a higher
                strike should not cost more).
              </li>
            ))}
          </ul>
          <p data-testid="distribution-corrected">
            The bars pool those strikes to their average so no range is negative.
          </p>
        </div>
      )}
      {anyStale ? (
        <p className="text-mer-xs text-mer-ink-muted" data-testid="distribution-stale-note">
          Fair values tagged stale are the last ones the pricing service published; each tag says
          why.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-mer-sm" data-testid="distribution-table">
          <caption className="pb-mer-1 text-left text-mer-xs text-mer-ink-muted">
            YES price, fair value and edge by strike
          </caption>
          <thead>
            <tr className="text-left text-mer-ink-muted">
              <th scope="col" className="py-0.5 pr-mer-2 font-medium">
                Strike
              </th>
              <th scope="col" className="py-0.5 pr-mer-2 font-medium">
                Market YES
              </th>
              <th scope="col" className="py-0.5 pr-mer-2 font-medium">
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
                <th scope="row" className="py-0.5 pr-mer-2 text-left font-normal">
                  {formatStrike(point.strikeCents)}
                </th>
                <td className="mer-num py-0.5 pr-mer-2">{cents(point.yesCents)}</td>
                <td className="mer-num py-0.5 pr-mer-2">
                  <FairCell point={point} nowSecs={nowSecs} />
                </td>
                <td className="py-0.5">
                  {point.yesCents === null || point.fairCents === null ? (
                    "—"
                  ) : (
                    <EdgeLabel
                      edge={edgeCents(point.yesCents, point.fairCents)}
                      muted={point.fairStale === true}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="text-mer-sm">
        <summary className="min-h-9 cursor-pointer text-mer-ink-muted">
          Chance by range (the chart&apos;s numbers)
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="distribution-buckets">
            <thead>
              <tr className="text-left text-mer-ink-muted">
                <th scope="col" className="py-0.5 pr-mer-2 font-medium">
                  Close
                </th>
                <th scope="col" className="py-0.5 pr-mer-2 font-medium">
                  Market
                </th>
                <th scope="col" className="py-0.5 font-medium">
                  Fair value
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucketLabel(bucket)}>
                  <th scope="row" className="py-0.5 pr-mer-2 text-left font-normal">
                    {bucketWords(bucket)}
                  </th>
                  <td className="mer-num py-0.5 pr-mer-2">{percent(bucket.marketPercent)}</td>
                  <td className="mer-num py-0.5">{percent(bucket.fairPercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
