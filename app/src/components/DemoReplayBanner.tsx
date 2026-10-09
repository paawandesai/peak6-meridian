/**
 * M4-08: Demo mode replay banner.
 * Shows "DEMO: replaying <date>" when DEMO_MODE is replay.
 * Devnet only.
 */

export function DemoReplayBanner() {
  const mode = process.env.NEXT_PUBLIC_DEMO_MODE || "live";
  const replayDate = process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE;

  if (mode !== "replay" || !replayDate) {
    return null;
  }

  return (
    <div
      style={{
        background: "#ff6b35",
        color: "white",
        padding: "8px 16px",
        textAlign: "center",
        fontWeight: "bold",
        fontSize: "14px",
      }}
    >
      🎬 DEMO: Replaying historical trading day {replayDate}
    </div>
  );
}
