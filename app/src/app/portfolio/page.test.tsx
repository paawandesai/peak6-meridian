import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PortfolioPage from "./page";

describe("portfolio page", () => {
  it("renders the shared header and a Portfolio heading", () => {
    const html = renderToStaticMarkup(<PortfolioPage />);
    expect(html).toContain("<h1");
    expect(html).toContain("Meridian");
    expect(html).toContain(">Portfolio<");
  });
});
