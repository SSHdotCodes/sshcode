import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildHomeChatTabs } from "./ChatTabs.logic";

it("lists a visible fork in its tab and keeps nested subagents out", () => {
  const environmentId = EnvironmentId.make("mac");
  const parentThreadId = ThreadId.make("parent");
  const fork = makeThreadShellFixture({ environmentId, id: ThreadId.make("fork") });
  const child = makeThreadShellFixture({ environmentId, id: ThreadId.make("subagent") });
  const chatTab = { name: "Work", position: 0, manual: true };

  expect(
    buildHomeChatTabs(
      [
        {
          ...fork,
          lineage: { parentThreadId, rootThreadId: parentThreadId, relationshipToParent: "fork" },
          source: { ...fork.source, chatTab },
        },
        {
          ...child,
          lineage: {
            parentThreadId,
            rootThreadId: parentThreadId,
            relationshipToParent: "subagent",
          },
          source: { ...child.source, chatTab },
        },
      ],
      new Map(),
      [],
    ),
  ).toMatchObject([{ name: "Work", threadKeys: new Set(["mac:fork"]) }]);
});

it("shows a server-created tab before any chats are filed into it", () => {
  const environmentId = EnvironmentId.make("mac");
  const tab = { name: "Work", position: 0, keepEmpty: true };
  expect(buildHomeChatTabs([], new Map(), [{ environmentId, tab }])).toMatchObject([
    { name: "Work", threadKeys: new Set() },
  ]);
});
