import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { openTeamBoard, showTeamBoardPill, teamBoardOpenAtom } from "./teamBoard";

// The lead's board has posts, so its pill would show in the lead's own chat.
vi.mock("@t3tools/client-runtime/state/team-board", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/team-board")>()),
  teamBoardPill: () => ({ postCount: 3, overlapCount: 0, unread: false }),
}));

describe("opening the team board", () => {
  it("opens a dialog from a subagent's chat, where the lead's pill is not on screen", () => {
    const lead = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("lead"));
    const open = teamBoardOpenAtom(threadKey(lead));
    openTeamBoard(lead, null);
    expect(appAtomRegistry.get(open)?.from).toBe("elsewhere");
    const hide = showTeamBoardPill(threadKey(lead));
    openTeamBoard(lead, null);
    expect(appAtomRegistry.get(open)?.from).toBe("pill");
    hide();
    openTeamBoard(lead, null);
    expect(appAtomRegistry.get(open)?.from).toBe("elsewhere");
  });
});

it("an unrelated mounted pill cannot redirect a subagent's note out of its dialog", () => {
  const lead = scopeThreadRef(EnvironmentId.make("env-lead"), ThreadId.make("same-id"));
  const elsewhere = scopeThreadRef(EnvironmentId.make("env-elsewhere"), ThreadId.make("same-id"));
  const cleanup = showTeamBoardPill(threadKey(elsewhere));
  try {
    openTeamBoard(lead, null);
    expect(appAtomRegistry.get(teamBoardOpenAtom(threadKey(lead)))?.from).toBe("elsewhere");
  } finally {
    cleanup();
  }
});
