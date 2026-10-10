/**
 * Lighthouse CI configuration for M2-06 AC5: Trade page accessibility ≥ 90.
 * Run after the app is started on localhost with a market available.
 */
module.exports = {
  ci: {
    collect: {
      url: ["http://127.0.0.1:3100/trade/*"],
      numberOfRuns: 1,
      settings: {
        onlyCategories: ["accessibility"],
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
