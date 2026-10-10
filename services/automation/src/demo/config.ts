/**
 * M4-08: Demo mode configuration.
 * Controls historical price replay for demo trading days.
 */

export type DemoMode = "live" | "replay";

export interface DemoConfig {
  readonly mode: DemoMode;
  readonly replayDate?: string; // YYYY-MM-DD, required when mode=replay
}

/**
 * Load demo mode configuration from environment.
 * Defaults to live mode. In replay mode, DEMO_REPLAY_DATE must be set.
 */
export function loadDemoConfig(): DemoConfig {
  const mode = (process.env.DEMO_MODE || "live") as DemoMode;

  if (mode !== "live" && mode !== "replay") {
    throw new Error(`Invalid DEMO_MODE: ${mode}. Must be 'live' or 'replay'`);
  }

  const replayDate = process.env.DEMO_REPLAY_DATE;

  if (mode === "replay") {
    if (!replayDate) {
      throw new Error("DEMO_REPLAY_DATE required when DEMO_MODE=replay");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(replayDate)) {
      throw new Error(`Invalid DEMO_REPLAY_DATE format: ${replayDate}. Must be YYYY-MM-DD`);
    }
  }

  return { mode, replayDate: mode === "replay" ? replayDate : undefined };
}
