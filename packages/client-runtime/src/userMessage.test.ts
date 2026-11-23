import { ScheduledTaskId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { agentMessagePreview, resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it.each(["image", "file", "recording"])(
    "hides an attachment-only bootstrap prompt with a %s attachment without changing the message",
    (type) => {
      const message = {
        role: "user",
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments: [{ type, id: "attachment-1" }],
      };
      expect(resolveUserMessagePresentation(message)).toEqual({
        text: "",
        attribution: null,
        scheduledTaskId: undefined,
      });
      expect(message.text).toBe(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT);
      expect(message.attachments).toEqual([{ type, id: "attachment-1" }]);
    },
  );

  it("hides surrounding whitespace along with the attachment-only bootstrap prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        text: ` \n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}\n `,
        attachments: [{ id: "attachment-1" }],
      }).text,
    ).toBe("");
  });

  it.each([undefined, []])("preserves the bootstrap text without attachments %j", (attachments) => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments,
      }).text,
    ).toBe(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT);
  });

  it.each([
    "What is in this picture?",
    `Please explain ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    `> ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    `\`${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}\``,
    `![Screenshot](t3-context://v1/image/screenshot)`,
    `${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}\n[Report](t3-context://v1/file/report)`,
  ])("preserves typed captions and context links verbatim: %s", (text) => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        text,
        attachments: [{ id: "attachment-1" }],
      }).text,
    ).toBe(text);
  });

  it("preserves an assistant's bootstrap text even with attachments", () => {
    expect(
      resolveUserMessagePresentation({
        role: "assistant",
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments: [{ id: "attachment-1" }],
      }).text,
    ).toBe(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT);
  });

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({
      text: "Check for crashes.\n",
      attribution: "automation",
      scheduledTaskId: undefined,
    });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, attribution: "automation", scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        attribution: "agent",
        scheduledTaskId: undefined,
      });
    }
  });

  it("attributes older server-sent restart continuations to SSHCode, not another agent", () => {
    const text = "Note: the SSHCode server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("agentMessagePreview", () => {
  it("skips the delegated role line and flattens markdown onto one line", () => {
    expect(
      agentMessagePreview(
        "Act as the implementation sub-agent for this task.\n\n## Goal\n**Fix** the `wo_a` path:\n- step one\n1. step two",
      ),
    ).toBe("Goal: Fix the wo_a path: step one step two");
  });

  it("keeps a heading's own punctuation", () => {
    expect(agentMessagePreview("# Done!\nShipped.")).toBe("Done! Shipped.");
  });

  it("keeps a message that only resembles the role line", () => {
    expect(agentMessagePreview("Please act as the reviewer.")).toBe("Please act as the reviewer.");
  });

  it("caps very long messages", () => {
    expect(agentMessagePreview("x".repeat(1000))).toHaveLength(240);
  });
});
