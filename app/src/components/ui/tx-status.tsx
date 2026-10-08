/** Transaction state line under the sign button, never a modal (design.md §3). */
export type TxStatusProps =
  | { readonly state: "simulating" }
  | { readonly state: "awaiting-signature" }
  | { readonly state: "confirming" }
  | { readonly state: "confirmed"; readonly slot: number; readonly explorerUrl: string }
  | { readonly state: "failed"; readonly reason: string };

export function txStatusText(props: TxStatusProps): string {
  switch (props.state) {
    case "simulating":
      return "Simulating…";
    case "awaiting-signature":
      return "Review and sign in your wallet";
    case "confirming":
      return "Confirming…";
    case "confirmed":
      return `Confirmed in slot ${props.slot}`;
    case "failed":
      return `Failed: ${props.reason}. Nothing was charged.`;
  }
}

const ICON: Record<TxStatusProps["state"], string> = {
  simulating: "◌",
  "awaiting-signature": "✎",
  confirming: "◌",
  confirmed: "✓",
  failed: "✕",
};

export function TxStatus(props: TxStatusProps) {
  return (
    <p
      role={props.state === "failed" ? "alert" : "status"}
      className={`flex items-center gap-mer-2 text-mer-sm ${props.state === "failed" ? "text-mer-loss" : props.state === "confirmed" ? "text-mer-gain" : "text-mer-ink"}`}
      data-state={props.state}
    >
      <span aria-hidden="true">{ICON[props.state]}</span>
      <span>{txStatusText(props)}</span>
      {props.state === "confirmed" ? (
        <a className="underline" href={props.explorerUrl} rel="noreferrer" target="_blank">
          (view on explorer)
        </a>
      ) : null}
    </p>
  );
}
