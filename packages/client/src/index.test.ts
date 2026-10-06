import { describe, expect, it } from "vitest";

import { PROGRAM_NAME, clientInfo } from "./index";

describe("clientInfo", () => {
  it("names the package and the program it targets", () => {
    expect(clientInfo()).toEqual({ name: "@meridian/client", program: "meridian" });
    expect(PROGRAM_NAME).toBe("meridian");
  });
});
