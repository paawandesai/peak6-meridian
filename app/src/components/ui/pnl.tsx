/**
 * Win/lose P&L (design.md §3): the sign character is always printed (it is part of `text`, from
 * the display adapter) and the colour only reinforces it; green and red are reserved for sign.
 */
export function Pnl({
  text,
  sign,
}: {
  /** Already formatted with an explicit sign, e.g. `+$3.80` or `−$1.20`. */
  readonly text: string;
  readonly sign: "gain" | "loss" | "zero";
}) {
  const hue =
    sign === "gain" ? "text-mer-gain" : sign === "loss" ? "text-mer-loss" : "text-mer-ink";
  return <span className={`mer-num font-medium ${hue}`}>{text}</span>;
}
