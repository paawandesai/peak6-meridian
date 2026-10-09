import { describe, expect, it, vi } from "vitest";

import { loadRejected, saveRejected } from "./rejected";

describe("rejected drafts", () => {
  it("round-trips ids through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveRejected(storage, new Set(["a", "b"]));
    expect([...loadRejected(storage)]).toEqual(["a", "b"]);
  });

  it("is empty for missing, corrupt or non-array data, and with no storage", () => {
    expect(loadRejected(undefined).size).toBe(0);
    expect(loadRejected({ getItem: () => null }).size).toBe(0);
    expect(loadRejected({ getItem: () => "{not json" }).size).toBe(0);
    expect(loadRejected({ getItem: () => '{"a":1}' }).size).toBe(0);
    expect([...loadRejected({ getItem: () => '["a",1,"b"]' })]).toEqual(["a", "b"]);
  });

  it("survives a storage that throws", () => {
    const broken = {
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    };
    expect(() => saveRejected(broken, new Set(["a"]))).not.toThrow();
    expect(
      loadRejected({
        getItem: () => {
          throw new Error("denied");
        },
      }).size,
    ).toBe(0);
  });
});
