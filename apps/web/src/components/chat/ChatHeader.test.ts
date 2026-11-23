import { describe, expect, it } from "vite-plus/test";
import { resolveRenameCommit } from "./ChatHeader";

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the field is left as it opened, even if the title changed meanwhile", () => {
    expect(
      resolveRenameCommit({
        title: "New thread",
        originalTitle: "Generated",
        startTitle: "New thread",
      }),
    ).toEqual({ action: "noop" });
    expect(
      resolveRenameCommit({ title: "Mine", originalTitle: "Generated", startTitle: "New thread" }),
    ).toEqual({ action: "commit", title: "Mine" });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
