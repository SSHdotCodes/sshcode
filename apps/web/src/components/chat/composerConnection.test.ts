import { describe, expect, it } from "vite-plus/test";
import { createEmptyThreadDraft } from "../../composerDraftStore";
import { canWaitForComposerConnection, waitForComposerDraftConnection } from "./composerConnection";

describe("sending a draft across reconnect", () => {
  it("keeps a changed draft for review instead of authorizing the old submission", async () => {
    let draft = { ...createEmptyThreadDraft(), prompt: "first" };
    const send = waitForComposerDraftConnection(
      () => draft,
      async () => ({ _tag: "Success" }),
    );
    draft = { ...draft, prompt: "edited" };
    expect(await send).toMatch(/draft changed/i);
  });

  it("accepts the same content after a fresh store snapshot", async () => {
    const draft = { ...createEmptyThreadDraft(), prompt: "first" };
    expect(
      await waitForComposerDraftConnection(
        () => ({ ...draft }),
        async () => ({ _tag: "Success" }),
      ),
    ).toBeNull();
    expect(
      await waitForComposerDraftConnection(
        () => draft,
        async () => ({ _tag: "Failure" }),
      ),
    ).toMatch(/still in the composer/);
  });

  it("only holds submissions for environments that can reconnect", () => {
    expect(
      [
        "available",
        "error",
        "unsupported",
        "connected",
        "offline",
        "connecting",
        "reconnecting",
      ].map((phase) =>
        canWaitForComposerConnection(phase as Parameters<typeof canWaitForComposerConnection>[0]),
      ),
    ).toEqual([false, false, false, false, true, true, true]);
  });
});
