/**
 * Fake data-API HTTP for tests and the local end-to-end run: answers Tiingo and Twelve Data
 * requests with fixed closes (no network). Options make one source disagree or go down.
 */
import type { IsoDate } from "../calendar";
import type { HttpGet } from "../prevCloses";

export interface FakeSourcesOptions {
  /** Close per ticker, in cents, served by both sources. */
  readonly closes: Readonly<Record<string, number>>;
  /** The ET date of the bar both sources return. */
  readonly date: IsoDate;
  /** Twelve Data reports this many cents more than Tiingo for every ticker. */
  readonly twelveDataSkewCents?: number;
  /** Twelve Data's latest bar is for this date instead (a stale source). */
  readonly twelveDataDate?: IsoDate;
  readonly tiingoDown?: boolean;
  readonly twelveDataDown?: boolean;
}

function dollars(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;
}

/** Counts the requests per host, so tests can assert on retries. */
export function fakeSourcesHttp(options: FakeSourcesOptions): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const http: HttpGet = (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const down = parsed.hostname === "api.tiingo.com" ? options.tiingoDown : options.twelveDataDown;
    if (down === true) {
      return Promise.resolve({ status: 503, text: () => Promise.resolve("unavailable") });
    }
    if (parsed.hostname === "api.tiingo.com") {
      const ticker = decodeURIComponent(parsed.pathname.split("/")[3] ?? "").toUpperCase();
      const close = options.closes[ticker];
      const body =
        close === undefined
          ? []
          : [{ date: `${options.date}T00:00:00.000Z`, close: dollars(close) }];
      return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    }
    const ticker = parsed.searchParams.get("symbol") ?? "";
    const close = options.closes[ticker];
    const values =
      close === undefined
        ? []
        : [
            {
              datetime: options.twelveDataDate ?? options.date,
              close: dollars(close + (options.twelveDataSkewCents ?? 0)),
            },
          ];
    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ status: "ok", values })),
    });
  };
  return Object.assign(http, { calls });
}
