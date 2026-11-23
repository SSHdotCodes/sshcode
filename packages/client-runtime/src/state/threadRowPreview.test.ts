import { describe, expect, it } from "vite-plus/test";

import { threadRowPreview } from "./threadRowPreview.ts";

describe("threadRowPreview", () => {
  it("shows what a working agent last said", () => {
    expect(
      threadRowPreview({ stepText: "Running tests", replyPreview: "Fixing the failing test." }),
    ).toEqual({ text: "Fixing the failing test.", kind: "note" });
  });

  it("shows the kind of step while the agent has said nothing yet", () => {
    expect(threadRowPreview({ stepText: "Running tests", replyPreview: null })).toEqual({
      text: "Running tests",
      kind: "step",
    });
    // An older server sends no words while the agent works.
    expect(threadRowPreview({ stepText: "Thinking", replyPreview: undefined })).toEqual({
      text: "Thinking",
      kind: "step",
    });
  });

  it("keeps what the chat asks of the user ahead of the agent's words", () => {
    expect(
      threadRowPreview({ stepText: "Approve?", asking: true, replyPreview: "Running the build." }),
    ).toEqual({ text: "Approve?", kind: "step" });
  });

  it("otherwise shows how the latest reply opens", () => {
    expect(threadRowPreview({ stepText: null, replyPreview: "All green." })).toEqual({
      text: "All green.",
      kind: "reply",
    });
  });

  it("shows nothing when there is nothing to say", () => {
    expect(threadRowPreview({ stepText: null, replyPreview: undefined })).toBeNull();
    expect(threadRowPreview({ stepText: " ", replyPreview: null })).toBeNull();
  });
});
