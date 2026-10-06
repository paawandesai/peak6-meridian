import { describe, expect, it } from "vitest";

import { health } from "./index";

describe("health", () => {
  it("reports the automation service as ok", () => {
    expect(health()).toEqual({ service: "automation", status: "ok" });
  });
});
