import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";
import HomePage from "./page";
import { TestMarketProvider } from "@/components/test-market-context";

describe("home page", () => {
  it("renders the Meridian header, a loading markets state and the wallet slot", () => {
    const html = renderToStaticMarkup(
      <TestMarketProvider>
        <HomePage />
      </TestMarketProvider>,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Meridian");
    expect(html).toContain("Loading markets");
  });

  it("is wrapped by the root layout", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>child</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<p>child</p>");
    expect(metadata.title).toBe("Meridian");
  });
});
