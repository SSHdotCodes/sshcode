// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  detectQuestPanelRole,
  detectQuestFeed,
  listenForQuestComposer,
  postQuest,
  questThread,
  questThreadSnapshot,
} from "./questBridge";
import { makeThreadFixture } from "./test-fixtures";

const providers = [
  {
    instanceId: ProviderInstanceId.make("personal"),
    driver: ProviderDriverKind.make("claudeAgent"),
  },
];
const base = () =>
  makeThreadFixture({
    runtime: null,
    modelSelection: { instanceId: providers[0]!.instanceId, model: "opus" },
  });
const runtime = (status: "running" | "idle" | "failed") => ({
  status,
  activeRunId: null,
  providerInstanceId: providers[0]!.instanceId,
  providerName: null,
  lastError: null,
  updatedAt: "2026-10-19T20:00:00.000Z",
});
const run = (status: "completed" | "failed" | "interrupted") => ({
  runId: RunId.make("run"),
  status,
  requestedAt: null,
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

afterEach(() => {
  window.sessionStorage.clear();
  delete window.SSHCodeQuest;
});

describe("Quest panel roles", () => {
  it("leaves ordinary tabs alone and remembers each supported role through navigation", () => {
    const storage = window.sessionStorage;
    expect(detectQuestPanelRole("", storage)).toBeNull();
    expect(detectQuestPanelRole("?sshcodePanel=unknown", storage)).toBeNull();
    for (const role of ["overview", "thread", "new"]) {
      expect(detectQuestPanelRole(`?sshcodePanel=${role}`, storage)).toBe(role);
      expect(detectQuestPanelRole("?other=1", storage)).toBe(role);
    }
    expect(detectQuestPanelRole("", { getItem: () => null, setItem: () => {} })).toBeNull();
  });
  it("works with storage disabled", () => {
    const storage = {
      getItem: () => {
        throw Error("denied");
      },
      setItem: () => {
        throw Error("denied");
      },
    };
    expect(detectQuestPanelRole("?sshcodePanel=thread", storage)).toBe("thread");
    expect(detectQuestPanelRole("", storage)).toBeNull();
  });
  it("does not call a missing bridge", () => {
    expect(postQuest("ready", { v: 1, role: "new", path: "/new" })).toBe(false);
  });
});

describe("Quest feed selection", () => {
  it("requires the explicit flag, remembers it through navigation, and permits revocation", () => {
    const storage = window.sessionStorage;
    expect(detectQuestFeed("?sshcodePanel=overview", storage)).toBe(false);
    expect(detectQuestFeed("?sshcodePanel=new&sshcodeFeed=1", storage)).toBe(true);
    expect(detectQuestFeed("", storage)).toBe(true);
    expect(detectQuestFeed("?sshcodeFeed=0", storage)).toBe(false);
    expect(detectQuestFeed("", storage)).toBe(false);
    expect(detectQuestFeed("?sshcodeFeed=true", storage)).toBe(false);
  });
  it("honors the URL when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw Error("denied");
      },
      setItem: () => {
        throw Error("denied");
      },
    };
    expect(detectQuestFeed("?sshcodeFeed=1", storage)).toBe(true);
    expect(detectQuestFeed("", storage)).toBe(false);
  });
});

describe("Quest thread state", () => {
  it("resolves custom provider instances through the mascot driver helper", () => {
    expect(questThread(base(), providers).harness).toBe("claude");
    expect(questThread(base(), []).harness).toBeNull();
    for (const driver of ["codex", "grok", "muse"] as const) {
      expect(
        questThread(base(), [{ ...providers[0]!, driver: ProviderDriverKind.make(driver) }])
          .harness,
      ).toBe(driver);
    }
    expect(
      questThread(base(), [{ ...providers[0]!, driver: ProviderDriverKind.make("openCode") }])
        .harness,
    ).toBeNull();
    for (const driver of [
      "cursor",
      "opencode",
      "pi",
      "antigravity",
      "acpRegistry",
      "qwen",
      "qwenCode",
    ]) {
      expect(
        questThread(base(), [{ ...providers[0]!, driver: ProviderDriverKind.make(driver) }])
          .harness,
      ).toBeNull();
    }
  });
  it.each([
    [{}, "idle", false],
    [{ runtime: runtime("running") }, "working", false],
    [{ runtime: runtime("idle") }, "working", false],
    [{ runtime: runtime("failed") }, "failed", false],
    [
      { runtime: { ...runtime("failed"), lastErrorClass: "usage_limit" as const } },
      "failed",
      false,
    ],
    [{ latestRun: run("completed") }, "done", false],
    [{ latestRun: run("failed") }, "failed", false],
    [{ latestRun: run("interrupted") }, "failed", false],
    [{ runtime: runtime("running"), hasPendingApprovals: true }, "waiting", true],
    [{ hasPendingUserInput: true }, "waiting", true],
    [{ pendingSubagentRequest: "approval" as const }, "waiting", true],
    [{ pendingSubagentRequest: "user_input" as const }, "waiting", true],
  ])("maps sidebar and mascot states: %j", (overrides, state, needsUser) => {
    expect(questThread({ ...base(), ...overrides }, providers)).toMatchObject({ state, needsUser });
  });
});

describe("Quest snapshots", () => {
  it("excludes archived and settled chats, prioritizes user input then work, and caps at 40", () => {
    const threads = Array.from({ length: 45 }, (_, index) => ({
      ...base(),
      id: ThreadId.make(`thread-${index}`),
      updatedAt: new Date(Date.UTC(2026, 9, 19, 0, index)).toISOString(),
    }));
    const result = questThreadSnapshot(
      [
        ...threads,
        { ...base(), id: ThreadId.make("archived"), archivedAt: "2026-01-01" },
        {
          ...base(),
          id: ThreadId.make("settled"),
          settledOverride: "settled",
          hasPendingUserInput: true,
        },
        { ...base(), id: ThreadId.make("work"), runtime: runtime("running") },
        { ...base(), id: ThreadId.make("question"), hasPendingUserInput: true },
      ],
      () => providers,
    );
    expect(result).toHaveLength(40);
    expect(result.slice(0, 4).map((thread) => thread.threadId)).toEqual([
      "question",
      "work",
      "thread-44",
      "thread-43",
    ]);
    expect(result.some((thread) => ["archived", "settled"].includes(thread.threadId))).toBe(false);
    expect(threads[0]?.id).toBe("thread-0");
  });
  it("breaks timestamp ties deterministically across environments", () => {
    const a = { ...base(), environmentId: EnvironmentId.make("a") };
    const b = { ...base(), environmentId: EnvironmentId.make("b") };
    expect(
      questThreadSnapshot([b, a], () => providers).map((thread) => thread.environmentId),
    ).toEqual(["a", "b"]);
  });
});

describe("Quest composer events", () => {
  it("focuses before insertion, routes send and focus, and removes the listener", () => {
    const calls: string[] = [];
    const actions = {
      insertText: (text: string) => calls.push(text),
      send: () => calls.push("send"),
      focusComposer: () => calls.push("focus"),
    };
    const target = new EventTarget();
    const remove = listenForQuestComposer(target, actions);
    const emit = (detail: unknown) =>
      target.dispatchEvent(new CustomEvent("sshcode-quest", { detail }));
    emit({ type: "insertText", text: "dictated text" });
    emit({ type: "send" });
    emit({ type: "focusComposer" });
    expect(calls).toEqual(["focus", "dictated text", "send", "focus"]);
    remove();
    emit({ type: "send" });
    expect(calls).toHaveLength(4);
  });
  it("ignores malformed events", () => {
    const send = vi.fn();
    const target = new EventTarget();
    const remove = listenForQuestComposer(target, { insertText: send, send, focusComposer: send });
    for (const detail of [
      null,
      "send",
      {},
      { type: "unknown" },
      { type: "insertText", text: 1 },
      { type: "insertText" },
    ]) {
      target.dispatchEvent(new CustomEvent("sshcode-quest", { detail }));
    }
    expect(send).not.toHaveBeenCalled();
    remove();
  });
});
