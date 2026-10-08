"use client";

import { useEffect, useState } from "react";

export type AsyncState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/** Runs `load` on mount and whenever `deps` change; ignores results of superseded runs. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    load().then(
      (value) => current && setState({ status: "ready", value }),
      (error: unknown) =>
        current &&
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      current = false;
    };
  }, deps);
  return state;
}
