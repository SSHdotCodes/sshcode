import { describe, expect, it } from "@effect/vitest";

import { makeComputerObservations, observationCharacterLimit } from "./ComputerObservations.ts";

const tree = Array.from(
  { length: 80 },
  (_, index) => `  s12345678:${index} button "item ${index}"`,
).join("\n");

describe("computer observations", () => {
  it("keeps native refs and returns a tiny unchanged payload", () => {
    const cache = makeComputerObservations();
    const first = cache.observe({
      scope: "lease-a",
      now: 0,
      text: tree,
      captureId: "native-image",
    });
    const next = cache.observe({ scope: "lease-a", now: 1, text: tree, since: first.snapshotId });
    expect(first.kind).toBe("full");
    expect(first.text).toBe(tree);
    expect(first.captureId).toBe("native-image");
    expect(next.kind).toBe("unchanged");
    expect(next.text.length).toBeLessThan(20);
  });

  it("uses a smaller, complete-line replacement for sparse changes", () => {
    const cache = makeComputerObservations();
    const first = cache.observe({ scope: "a", now: 0, text: tree });
    const changed = tree.replace('button "item 40"', 'button "selected"');
    const next = cache.observe({ scope: "a", now: 1, text: changed, since: first.snapshotId });
    expect(next.kind).toBe("patch");
    expect(next.text).toBe('@@ line 41, remove 1, insert 1 @@\n  s12345678:40 button "selected"');
    expect(next.text.length).toBeLessThan(first.text.length / 20);
  });

  it("refreshes a changing native snapshot prefix instead of claiming old refs are unchanged", () => {
    const rows = Array.from(
      { length: 180 },
      (_, index) => `[${index}] button "item ${index}"`,
    ).join("\n");
    const nativeTree = (id: string) =>
      `snapshot ${id}; refs are runtime-one/${id}:N for [N]\n${rows}`;
    const cache = makeComputerObservations();
    const first = cache.observe({ scope: "a", now: 0, text: nativeTree("s11111111") });
    const next = cache.observe({
      scope: "a",
      now: 1,
      text: nativeTree("s22222222"),
      since: first.snapshotId,
    });
    expect(next.kind).toBe("patch");
    expect(next.text).toBe(
      "@@ line 1, remove 1, insert 1 @@\nsnapshot s22222222; refs are runtime-one/s22222222:N for [N]",
    );
    expect(JSON.stringify(next).length).toBeLessThan(JSON.stringify(first).length / 10);
  });

  it("falls back to a full tree when a patch would cost more", () => {
    const cache = makeComputerObservations();
    const first = cache.observe({ scope: "a", now: 0, text: "s123:1 ok" });
    expect(
      cache.observe({ scope: "a", now: 1, text: "s123:1 no", since: first.snapshotId }).kind,
    ).toBe("full");
  });

  it("never reads a baseline from another lease, an expired baseline, or an evicted baseline", () => {
    const cache = makeComputerObservations({ maxCount: 2, ttlMs: 100 });
    const first = cache.observe({ scope: "a", now: 0, text: tree });
    expect(cache.observe({ scope: "b", now: 1, text: tree, since: first.snapshotId }).kind).toBe(
      "full",
    );
    const third = cache.observe({ scope: "a", now: 2, text: tree });
    expect(cache.observe({ scope: "a", now: 3, text: tree, since: first.snapshotId }).kind).toBe(
      "full",
    );
    expect(cache.observe({ scope: "a", now: 103, text: tree, since: third.snapshotId }).kind).toBe(
      "full",
    );
  });

  it("bounds output on complete lines and preserves truncation metadata", () => {
    const cache = makeComputerObservations();
    const result = cache.observe({
      scope: "a",
      now: 0,
      text: "s123:1 button\ns123:2 input",
      maxChars: 14,
      truncated: true,
      omittedLines: 5,
    });
    expect(result.text).toBe("s123:1 button");
    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBe(6);
    expect(cache.observe({ scope: "a", now: 1, text: "s123:1 button", maxChars: 2 }).text).toBe("");
  });

  it("keeps native truncation and degraded accessibility hints when shortening a tree", () => {
    const native = `snapshot s12345678\n${tree}\n[tree truncated]\n[accessibility degraded: partial_tree]`;
    const result = makeComputerObservations().observe({
      scope: "a",
      now: 0,
      text: native,
      maxChars: 120,
    });
    expect(result.text).toContain("snapshot s12345678");
    expect(result.text).toContain("[tree truncated]\n[accessibility degraded: partial_tree]");
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.omittedLines).toBeGreaterThan(0);
  });

  it("caps defaults and oversized requests without cutting refs", () => {
    expect(observationCharacterLimit()).toBe(6_000);
    expect(observationCharacterLimit(Infinity)).toBe(6_000);
    expect(observationCharacterLimit(40_000)).toBe(20_000);
    const result = makeComputerObservations().observe({
      scope: "a",
      now: 0,
      text: tree.repeat(10),
      maxChars: 40_000,
    });
    expect(result.text.length).toBeLessThanOrEqual(20_000);
    expect(result.truncated).toBe(true);
  });
});
