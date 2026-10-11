import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StrikeSelector } from "./strike-selector";
import { ladder } from "@/components/fair-value/test-support";

const strikes = [...ladder()].sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : 1));
const [m170, m180, m190] = strikes;

describe("StrikeSelector", () => {
  it("is a labelled radio group with one option per strike, the selected one checked", () => {
    render(
      <StrikeSelector
        ticker="NVDA"
        strikes={strikes}
        selected={m180?.address ?? null}
        onSelect={() => undefined}
      />,
    );
    const group = screen.getByRole("group", { name: "Strike" });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["$170", "$180", "$190"]);
    expect(screen.getByRole("radio", { name: "$180" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "$170" })).not.toBeChecked();
    // One group name per ticker, so arrow keys stay inside this selector.
    expect(radios.every((r) => r.getAttribute("name") === "strike-NVDA")).toBe(true);
  });

  it("reports the market address of the strike chosen", () => {
    const onSelect = vi.fn();
    render(
      <StrikeSelector
        ticker="NVDA"
        strikes={strikes}
        selected={m180?.address ?? null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "$190" }));
    expect(onSelect).toHaveBeenCalledWith(m190?.address);
    expect(m170).toBeDefined();
  });

  it("checks nothing when no strike is selected", () => {
    render(
      <StrikeSelector ticker="NVDA" strikes={strikes} selected={null} onSelect={() => undefined} />,
    );
    expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });
});
