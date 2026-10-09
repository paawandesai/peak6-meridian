import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "./app-shell";

describe("AppShell", () => {
  it("wraps its children in the shared header and a main landmark", () => {
    const html = renderToStaticMarkup(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Meridian");
    expect(html).toMatch(/<main[^>]*>.*<p>page content<\/p>.*<\/main>/s);
  });

  it("is narrow by default and wide on request", () => {
    const narrow = renderToStaticMarkup(<AppShell>x</AppShell>);
    const wide = renderToStaticMarkup(<AppShell width="wide">x</AppShell>);
    expect(narrow).toContain("max-w-3xl");
    expect(wide).toContain("max-w-5xl");
    expect(wide).not.toContain("max-w-3xl");
  });
});
