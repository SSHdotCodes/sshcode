import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentMessagePresentation,
  resolveAnsweredQuestionPresentation,
} from "./agentMessagePresentation";

describe("resolveAgentMessagePresentation", () => {
  it("previews delegated tasks using context labels and the shared markdown cleanup", () => {
    expect(
      resolveAgentMessagePresentation({
        senderTitle: "  Mobile implementation  ",
        text: "Act as the implementation sub-agent for this task.\n\n## Goal\nFix **[the feed](t3-context://v1/file/feed)**.\n- Keep attachments.",
      }),
    ).toEqual({
      label: "Message from Mobile implementation",
      preview: "Goal: Fix the feed. Keep attachments.",
      status: null,
      accessibilityLabel:
        "Message from Mobile implementation: Goal: Fix the feed. Keep attachments.",
    });
  });

  it.each([undefined, null, "", " \n "])(
    "falls back for an unavailable sender title: %j",
    (senderTitle) => {
      expect(resolveAgentMessagePresentation({ text: "Update", senderTitle }).label).toBe(
        "Message from another agent",
      );
    },
  );

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "labels %s messages as steers",
    (inputIntent) => {
      expect(
        resolveAgentMessagePresentation({
          text: "Use the shared helper",
          senderTitle: "Parent",
          inputIntent,
        }).label,
      ).toBe("Steer from Parent");
    },
  );

  it("keeps attachment-only messages readable without an empty preview separator", () => {
    expect(resolveAgentMessagePresentation({ text: " \n " }).accessibilityLabel).toBe(
      "Message from another agent",
    );
  });

  it("bounds long previews through the shared helper", () => {
    expect(resolveAgentMessagePresentation({ text: "x".repeat(300) }).preview).toHaveLength(240);
  });

  it.each(["completed", "pending", "waiting"] as const)(
    "omits ordinary %s delivery status",
    (status) => {
      expect(resolveAgentMessagePresentation({ text: "Update", status }).status).toBeNull();
    },
  );

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "exposes %s delivery status in the header and accessible label",
    (status) => {
      const presentation = resolveAgentMessagePresentation({ text: "Update", status });
      expect(presentation.status).toBe(status);
      expect(presentation.accessibilityLabel).toBe(`Message from another agent: Update: ${status}`);
    },
  );
});

describe("resolveAnsweredQuestionPresentation", () => {
  it("previews the answer from the question card when it is loaded", () => {
    expect(
      resolveAnsweredQuestionPresentation({
        answer: {
          requestId: "q",
          questionTextById: { q1: "Trim it?" },
          answers: { q1: "Trim it" },
          attachmentsByQuestionId: {},
        },
        text: "Trim it?\nTrim it",
      }),
    ).toEqual({
      label: "Answered question",
      preview: "Trim it",
      accessibilityLabel: "Answered question: Trim it",
    });
  });

  it("falls back to the answer message's own question and answer blocks", () => {
    expect(
      resolveAnsweredQuestionPresentation({
        answer: undefined,
        text: "Which color?\nBlue\n\nWhich size?\nLarge",
      }),
    ).toMatchObject({ label: "Answered 2 questions", preview: "Blue · Large" });
  });
});
