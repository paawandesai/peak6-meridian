/**
 * Lighthouse CI configuration for M2-06 AC5: Trade page accessibility ≥ 90.
 * Run after production build is started (pnpm --dir ../../app start) with a market available.
 *
 * Usage:
 *   LIGHTHOUSE_URL=http://localhost:3000/trade/<market-address> pnpm run lighthouse
 *
 * The URL must be a specific market address, not a glob pattern (LHCI does not expand wildcards).
 */
const url = process.env.LIGHTHOUSE_URL;
if (!url) {
  throw new Error("LIGHTHOUSE_URL environment variable is required (e.g., http://localhost:3000/trade/<market-address>)");
}

module.exports = {
  ci: {
    collect: {
      url: [url],
      numberOfRuns: 1,
      settings: {
        onlyCategories: ["accessibility"],
        formFactor: "mobile",
        // Don't wait for external resources that won't load in test
        blockedUrlPatterns: ["*tiingo.com*", "*twelvedata.com*", "*finnhub.io*"],
      },
    },
    assert: {
      assertions: {
        "categories:accessibility": ["error", { minScore: 0.9 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "./playwright-report/lighthouse",
    },
  },
};
