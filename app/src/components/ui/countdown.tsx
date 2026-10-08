import { formatCountdown } from "@/lib/time";

/**
 * A countdown to a target the caller supplies (a market's on-chain `close_ts`); it never counts
 * to a time it computed itself. Reduced-motion safe: no animation, and it is not a live region,
 * so assistive tech is not interrupted every second.
 */
export function Countdown({
  secondsLeft,
  label = "Closes in",
}: {
  readonly secondsLeft: number;
  readonly label?: string;
}) {
  return (
    <span className="mer-num">
      {label} <time>{formatCountdown(secondsLeft)}</time>
    </span>
  );
}
