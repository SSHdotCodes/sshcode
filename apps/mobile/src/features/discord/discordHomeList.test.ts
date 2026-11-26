import { expect, it } from "vite-plus/test";
import { ThreadId, RunId, ProviderInstanceId } from "@t3tools/contracts";
import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import { discordHomeList } from "./discordHomeList";

const parent = makeThreadShellFixture({
  id: ThreadId.make("parent"),
  pinnedAt: "2026-10-25T10:00:00Z",
});
const row: ThreadListV2ListItem = {
  type: "v2-thread",
  key: "parent",
  item: { thread: parent, pinned: true, snoozed: false, settled: false },
  timeLabel: "",
  snoozeWakeLabelText: undefined,
  face: undefined,
  hasQueuedMessages: false,
  showTrailingDivider: false,
  canMoveUp: false,
  canMoveDown: false,
};
const child = makeThreadShellFixture({
  id: ThreadId.make("child"),
  hasPendingUserInput: true,
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const grandchild = makeThreadShellFixture({
  id: ThreadId.make("grandchild"),
  hasPendingApprovals: true,
  lineage: { rootThreadId: parent.id, parentThreadId: child.id, relationshipToParent: "subagent" },
});

it("nests active descendants below their parent and drops idle children", () => {
  const idle = makeThreadShellFixture({ id: ThreadId.make("idle"), lineage: child.lineage });
  const rows = discordHomeList([row], new Set(), [child, grandchild, idle]);
  expect(rows.map((item) => (item.type === "v2-thread" ? item.item.thread.id : item.type))).toEqual(
    ["discord-heading", "parent", "child", "grandchild"],
  );
});

it("collapses the whole category including its thread descendants", () => {
  const rows = discordHomeList([row], new Set(["Pinned"]), [child, grandchild]);
  expect(rows).toEqual([
    {
      type: "discord-heading",
      key: "discord-heading:Pinned",
      label: "Pinned",
      count: 1,
      expanded: false,
    },
  ]);
});

it("does not group cached disconnected work as working", () => {
  const active = makeThreadShellFixture({
    id: ThreadId.make("active"),
    runtime: {
      status: "running",
      activeRunId: RunId.make("run"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Agent",
      lastError: null,
      updatedAt: "2026-10-26T12:00:00.000Z",
    },
  });
  const activeRow: ThreadListV2ListItem = {
    ...row,
    item: { ...row.item, thread: active, pinned: false },
  };
  const offline = discordHomeList(
    [activeRow],
    new Set(),
    [],
    new Map([[active.environmentId, "reconnecting"]]),
  );
  expect(offline[0]).toMatchObject({ type: "discord-heading", label: "Chats" });
  const connected = discordHomeList(
    [activeRow],
    new Set(),
    [],
    new Map([[active.environmentId, "connected"]]),
  );
  expect(connected[0]).toMatchObject({ type: "discord-heading", label: "Working" });
});

it("keeps an idle app-owned ancestor visible while its grandchild needs approval", () => {
  const idleParent = { ...child, hasPendingUserInput: false };
  const rows = discordHomeList([row], new Set(), [idleParent, grandchild]);
  expect(rows.flatMap((item) => (item.type === "v2-thread" ? [item.item.thread.id] : []))).toEqual([
    "parent",
    "child",
    "grandchild",
  ]);
});
