import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadProjectionCache } from "./threadProjectionCache";

describe("createThreadProjectionCache", () => {
  it("reuses the projection for equal inputs rebuilt on remount", () => {
    const derive = vi.fn((input: object) => ({ input }));
    const cache = createThreadProjectionCache(derive);
    const row = { id: "a" };
    const first = cache("t", {
      rows: [row],
      urls: new Map([["x", "u"]]),
      open: new Set(["r"]),
      n: 1,
    });
    const again = cache("t", {
      rows: [row],
      urls: new Map([["x", "u"]]),
      open: new Set(["r"]),
      n: 1,
    });
    expect(again).toBe(first);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("derives again when a streamed tail, map value or set member changes", () => {
    const derive = vi.fn((input: object, previous: unknown) => ({ input, previous }));
    const cache = createThreadProjectionCache(derive);
    const head = { id: "a" };
    const base = { rows: [head, { id: "b" }], urls: new Map([["x", "u"]]), open: new Set(["r"]) };
    const first = cache("t", base);
    const tail = cache("t", { ...base, rows: [head, { id: "b" }] });
    expect(tail).not.toBe(first);
    expect(derive).toHaveBeenLastCalledWith(expect.anything(), first);
    cache("t", { ...base, urls: new Map([["x", "v"]]) });
    cache("t", { ...base, open: new Set(["s"]) });
    expect(derive).toHaveBeenCalledTimes(4);
  });

  it("reads only the changed tail of a long transcript", () => {
    const rows = Array.from({ length: 10_000 }, (_, id) => ({ id }));
    const cache = createThreadProjectionCache((input: { rows: object[] }) => input.rows.length);
    cache("t", { rows });
    let reads = 0;
    const next = new Proxy([...rows.slice(0, -1), { id: -1 }], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    cache("t", { rows: next });
    expect(reads).toBe(1);
  });
});
