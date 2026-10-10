/**
 * Portfolio market-maker block (P1-5, design.md §2 Portfolio item 3 and §3 annotation (c)): a
 * dense table of net exposure, own resting orders, escrow and unsettled balance per strike.
 *
 * Visibility: the full table shows when the wallet has any resting order or any unsettled
 * OpenOrders balance (i.e. `mm.strikes` is non-empty); otherwise it collapses to one muted line,
 * so a P2 trader with no orders is not shown an empty MM table. At 390 px the secondary columns
 * (fill scenarios, bid/ask detail, escrow) are hidden and the table keeps Strike, Net, Orders and
 * Unsettled, so the page never scrolls sideways.
 */
import { marketLabel } from "./label";
import { formatSignedQty, type MmBlockModel, type MmSide, type MmStrike } from "./mm";
import { formatUsdSigned } from "@/lib/display";

export const MM_HEADING = "MM exposure";
export const MM_MISMATCH_NOTE =
  "Order count differs between your OpenOrders account and the book for the marked strikes; the book read may be stale. Reload to refresh.";

/** Columns hidden below the `md` breakpoint (768 px). */
const WIDE = "hidden md:table-cell";
const TH = "py-mer-1 pr-mer-2 font-medium whitespace-nowrap";
const TD = "mer-num py-mer-1 pr-mer-2 text-right whitespace-nowrap";

/** `30 @ 58¢` or `—`. */
function sideText(side: MmSide): string {
  return side.best === null ? "—" : `${side.qty} @ ${side.best}¢`;
}

/** `$12.40`, `$12.40 + 5 YES`, or `—` when nothing is owed. */
function unsettledText(usdc: bigint, yes: bigint): string {
  if (usdc === 0n && yes === 0n) return "—";
  return yes > 0n ? `${formatUsdSigned(usdc)} + ${yes} YES` : formatUsdSigned(usdc);
}

function StrikeRow({ strike }: { readonly strike: MmStrike }) {
  return (
    <tr className="border-t border-mer-rule">
      <th scope="row" className={`${TH} text-left`}>
        {marketLabel(strike.market)}
      </th>
      <td className={TD}>{formatSignedQty(strike.net)}</td>
      <td className={`${TD} ${WIDE}`}>{formatSignedQty(strike.netIfBidsFill)}</td>
      <td className={`${TD} ${WIDE}`}>{formatSignedQty(strike.netIfAsksFill)}</td>
      <td className={`${TD} ${WIDE}`}>{sideText(strike.bids)}</td>
      <td className={`${TD} ${WIDE}`}>{sideText(strike.asks)}</td>
      <td className={TD}>
        {strike.resting}
        {strike.mismatch ? (
          <span className="text-mer-warn" title={MM_MISMATCH_NOTE}>
            {" "}
            (book {strike.bids.count + strike.asks.count})
          </span>
        ) : null}
      </td>
      <td className={`${TD} ${WIDE}`}>
        {strike.escrowUsdc === 0n ? "—" : formatUsdSigned(strike.escrowUsdc)}
      </td>
      <td className={`${TD} pr-0`}>{unsettledText(strike.freeUsdc, strike.freeYes)}</td>
    </tr>
  );
}

export function MmBlock({
  mm,
  busy,
  onWithdraw,
}: {
  readonly mm: MmBlockModel;
  readonly busy: boolean;
  readonly onWithdraw: () => void;
}) {
  if (mm.strikes.length === 0) {
    return (
      <section aria-labelledby="mm-heading" className="text-mer-sm text-mer-ink-muted">
        <h3 id="mm-heading" className="inline font-medium">
          {MM_HEADING}:
        </h3>{" "}
        no open orders.
      </section>
    );
  }
  const mismatch = mm.strikes.some((strike) => strike.mismatch);
  return (
    <section aria-labelledby="mm-heading" className="flex flex-col gap-mer-2 text-mer-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-mer-4 gap-y-mer-1">
        <h3 id="mm-heading" className="font-medium">
          {MM_HEADING}
        </h3>
        <p className="flex flex-wrap items-center gap-x-mer-3 gap-y-mer-1">
          <span>
            Open orders <span className="mer-num">{mm.openOrders}</span>
          </span>
          <span>
            Bid escrow <span className="mer-num">{formatUsdSigned(mm.escrowUsdc)}</span>
          </span>
          <span>
            Unsettled <span className="mer-num">{formatUsdSigned(mm.unsettledUsdc)}</span>
            {mm.unsettledYes > 0n ? ` + ${mm.unsettledYes.toString()} YES` : ""}
          </span>
          {mm.withdrawable.length > 0 ? (
            <button
              type="button"
              className="rounded-mer border border-mer-control-border px-mer-2 py-mer-1 font-medium disabled:opacity-50"
              disabled={busy}
              onClick={onWithdraw}
            >
              Withdraw
            </button>
          ) : null}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-mer-xs md:text-mer-sm">
          <caption className="sr-only">Net exposure per strike</caption>
          <thead>
            <tr className="text-left text-mer-ink-muted">
              <th scope="col" className={TH}>
                Strike
              </th>
              <th scope="col" className={`${TH} text-right`}>
                <abbr title="YES-equivalent contracts held: YES less NO">Net</abbr>
              </th>
              <th scope="col" className={`${TH} text-right ${WIDE}`}>
                If bids fill
              </th>
              <th scope="col" className={`${TH} text-right ${WIDE}`}>
                If asks fill
              </th>
              <th scope="col" className={`${TH} text-right ${WIDE}`}>
                Bids qty @ best
              </th>
              <th scope="col" className={`${TH} text-right ${WIDE}`}>
                Asks qty @ best
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Orders
              </th>
              <th scope="col" className={`${TH} text-right ${WIDE}`}>
                Bid escrow
              </th>
              <th scope="col" className={`${TH} pr-0 text-right`}>
                Unsettled
              </th>
            </tr>
          </thead>
          <tbody>
            {mm.strikes.map((strike) => (
              <StrikeRow key={strike.market.address} strike={strike} />
            ))}
          </tbody>
          {mm.strikes.length > 1 ? (
            <tfoot>
              <tr className="border-t-2 border-mer-rule font-medium">
                <td className={`${TH} text-left`}>Total</td>
                <td className={TD} />
                <td className={`${TD} ${WIDE}`} />
                <td className={`${TD} ${WIDE}`} />
                <td className={`${TD} ${WIDE}`}>{mm.bidQty.toString()}</td>
                <td className={`${TD} ${WIDE}`}>{mm.askQty.toString()}</td>
                <td className={TD}>{mm.openOrders}</td>
                <td className={`${TD} ${WIDE}`}>{formatUsdSigned(mm.escrowUsdc)}</td>
                <td className={`${TD} pr-0`}>{unsettledText(mm.unsettledUsdc, mm.unsettledYes)}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <p className="text-mer-xs text-mer-ink-muted">
        Net counts YES held (wallet, unsettled and resting in asks) less NO held. Fill columns show
        net if every resting bid or ask filled. All figures come from your on-chain orders.
      </p>
      {mismatch ? (
        <p role="note" className="text-mer-xs text-mer-warn">
          {MM_MISMATCH_NOTE}
        </p>
      ) : null}
    </section>
  );
}
