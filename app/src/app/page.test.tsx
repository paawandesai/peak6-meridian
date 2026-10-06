import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";
import HomePage from "./page";

describe("home page", () => {
  it('renders the "Meridian" heading', () => {
    expect(renderToStaticMarkup(<HomePage />)).toBe("<main><h1>Meridian</h1></main>");
  });

  it("is wrapped by the root layout", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>Meridian</h1>");
    expect(metadata.title).toBe("Meridian");
  });
});
