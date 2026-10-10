import { afterEach, describe, expect, it, vi } from "vitest";

import { setVisibility } from "./account-test-support";
import { isDocumentVisible, onDocumentVisible } from "./visibility";

afterEach(() => {
  setVisibility("visible");
});

describe("visibility", () => {
  it("is visible unless the document reports hidden", () => {
    setVisibility("visible");
    expect(isDocumentVisible()).toBe(true);
    setVisibility("hidden");
    expect(isDocumentVisible()).toBe(false);
  });

  it("calls the listener only when the tab becomes visible, until unsubscribed", () => {
    const listener = vi.fn();
    const stop = onDocumentVisible(listener);
    setVisibility("hidden");
    expect(listener).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setVisibility("hidden");
    setVisibility("visible");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
