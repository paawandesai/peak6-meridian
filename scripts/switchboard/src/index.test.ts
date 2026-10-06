import { describe, expect, it } from "vitest";

import { scriptsInfo } from "./index";

describe("scriptsInfo", () => {
  it("names the package and where feed definitions live", () => {
    expect(scriptsInfo()).toEqual({ name: "switchboard-scripts", feedsDir: "oracle/feeds" });
  });
});
