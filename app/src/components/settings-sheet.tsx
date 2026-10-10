/**
 * P1-1: Settings sheet with demo mode toggle (devnet-only).
 * Shows current demo mode (Live/Replay) from env.
 * Devnet-only feature - hidden on other clusters.
 */

"use client";

import { useState } from "react";

export function SettingsSheet() {
  const [isOpen, setIsOpen] = useState(false);

  // Devnet-only feature
  const cluster = process.env.NEXT_PUBLIC_CLUSTER || "localnet";
  if (cluster !== "devnet") {
    return null;
  }

  const mode = process.env.NEXT_PUBLIC_DEMO_MODE || "live";
  const replayDate = process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE || "";

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm hover:bg-mer-paper"
        aria-label="Settings"
      >
        ⚙️
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-mer border border-mer-control-border bg-mer-surface p-mer-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-mer-4 flex items-center justify-between">
              <h2 className="text-mer-lg font-semibold">Settings</h2>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-mer-ink-muted hover:text-mer-ink"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-mer-4">
              <div>
                <label className="mb-mer-2 block text-mer-sm font-medium">
                  Demo Mode
                </label>
                <div className="rounded-mer border border-mer-control-border bg-mer-paper p-mer-3 text-mer-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {mode === "replay" ? `Replay: ${replayDate}` : "Live (Pyth)"}
                    </span>
                    <span
                      className={`rounded px-mer-2 py-mer-1 text-mer-xs font-semibold ${
                        mode === "replay"
                          ? "bg-orange-100 text-orange-800"
                          : "bg-green-100 text-green-800"
                      }`}
                    >
                      {mode === "replay" ? "REPLAY" : "LIVE"}
                    </span>
                  </div>
                  <p className="mt-mer-2 text-mer-xs text-mer-ink-muted">
                    {mode === "replay"
                      ? `Replaying historical trading day ${replayDate}`
                      : "Live market data from Pyth Pro"}
                  </p>
                </div>
              </div>

              <div className="rounded-mer border border-mer-warn/20 bg-mer-warn/10 p-mer-3 text-mer-xs text-mer-ink-muted">
                <strong>Note:</strong> Demo mode is configured at deployment time via
                NEXT_PUBLIC_DEMO_MODE. Contact admin to switch between Live and Replay modes.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
