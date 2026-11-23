import { describe, expect, it } from "vite-plus/test";
import { createdChatPresentation } from "./subagentDisplay.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { MessageId, RuntimeRequestId } from "@t3tools/contracts";

const item = {
  title: "Created chat title",
  targetModel: "qa-balanced",
  targetProviderInstanceId: v2ThreadShell.providerInstanceId,
};
describe("created chat cards", () => {
  it.each([
    ["idle", "Starting"],
    ["preparing", "Starting"],
    ["starting", "Starting"],
    ["running", "Working"],
    ["waiting", "Needs you"],
    ["completed", "Done"],
    ["failed", "Failed"],
    ["cancelled", "Stopped"],
    ["interrupted", "Stopped"],
    ["rolled_back", "Stopped"],
  ] as const)("reads %s from the chat itself", (status, statusLabel) => {
    const chat = createdChatPresentation(item, {
      ...v2ThreadShell,
      title: "Renamed chat",
      status,
      activityRunStatus: null,
    });
    expect(chat.title).toBe("Renamed chat");
    expect(chat.statusLabel).toBe(statusLabel);
    expect(chat.canOpenThread).toBe(true);
  });
  it("shows a first-line failure and retains the latest reply preview", () => {
    const chat = createdChatPresentation(item, {
      ...v2ThreadShell,
      status: "failed",
      activityRunStatus: null,
      lastError: "Budget exhausted. Add credits.\nMore diagnostics",
      createdChatPreview: "Starting the simulation",
      latestVisibleMessage: {
        id: MessageId.make("message:created"),
        role: "assistant",
        text: "Starting the simulation",
        updatedAt: v2ThreadShell.updatedAt,
      },
    });
    expect(chat.detail).toBe("Budget exhausted. Add credits.");
    expect(chat.preview).toBe("Starting the simulation");
  });
  it("preserves the creation title and disables a deleted chat, including old receipts", () => {
    expect(createdChatPresentation(item, null)).toMatchObject({
      title: item.title,
      statusLabel: "Chat deleted",
      canOpenThread: false,
    });
    expect(
      createdChatPresentation(item, { ...v2ThreadShell, deletedAt: v2ThreadShell.updatedAt }),
    ).toMatchObject({ statusLabel: "Chat deleted", canOpenThread: false });
    expect(createdChatPresentation(item, undefined)).toMatchObject({
      title: item.title,
      statusLabel: "Starting",
      canOpenThread: true,
    });
  });
  it("uses the current activity and pending request even if the latest run is a queued follow-up", () => {
    expect(
      createdChatPresentation(item, {
        ...v2ThreadShell,
        status: "queued",
        activityRunStatus: "running",
      }).statusLabel,
    ).toBe("Working");
    expect(
      createdChatPresentation(item, {
        ...v2ThreadShell,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:created"),
          kind: "user_input",
          createdAt: v2ThreadShell.updatedAt,
        },
      }).statusLabel,
    ).toBe("Needs you");
  });
});
