import { describe, expect, it } from "vite-plus/test";

import { agentWorkOnMachine } from "./keepAwake";

type Thread = Parameters<typeof agentWorkOnMachine>[0][number];
const thread = (patch: Record<string, unknown> = {}) =>
  ({
    environmentId: "mac",
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    ...patch,
  }) as unknown as Thread;

describe("agentWorkOnMachine", () => {
  it("reports nothing for finished chats and for chats that wait on the user", () => {
    expect(
      agentWorkOnMachine(
        [thread(), thread({ runtime: { status: "running" }, hasPendingUserInput: true })],
        "mac",
      ),
    ).toEqual({ working: false, waiting: false });
  });

  it("tells a running turn from a chat that waits on background work", () => {
    expect(agentWorkOnMachine([thread({ runtime: { status: "running" } })], "mac")).toEqual({
      working: true,
      waiting: false,
    });
    expect(agentWorkOnMachine([thread({ runtime: { status: "idle" } })], "mac")).toEqual({
      working: false,
      waiting: true,
    });
  });

  it("ignores other machines, and archived or deleted chats", () => {
    expect(
      agentWorkOnMachine(
        [
          thread({ environmentId: "studio", runtime: { status: "running" } }),
          thread({ archivedAt: "2026-11-14T05:00:00.000Z", runtime: { status: "running" } }),
          thread({ deletedAt: "2026-11-14T05:00:00.000Z", runtime: { status: "idle" } }),
        ],
        "mac",
      ),
    ).toEqual({ working: false, waiting: false });
    expect(agentWorkOnMachine([thread({ runtime: { status: "running" } })], null)).toEqual({
      working: false,
      waiting: false,
    });
  });
});
