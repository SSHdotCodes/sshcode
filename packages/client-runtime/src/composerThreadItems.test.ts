import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatMentionSearchQuery,
  chatMentionWords,
  matchComposerThreadItems,
  rankComposerChatMentions,
} from "./composerThreadItems.ts";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
const shell = (
  id: string,
  title: string,
  overrides: Partial<Parameters<typeof matchComposerThreadItems>[0]["shells"][number]> = {},
) => ({
  environmentId: env,
  id: ThreadId.make(id),
  title,
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

describe("matchComposerThreadItems", () => {
  it("offers nothing for a bare @ so the picker stays a file picker", () => {
    expect(
      matchComposerThreadItems({
        shells: [shell("t1", "Fix login")],
        environmentId: env,
        excludeThreadId: null,
        query: "  ",
      }),
    ).toEqual([]);
  });

  it("matches titles within the environment, newest first, skipping self and archived", () => {
    const items = matchComposerThreadItems({
      shells: [
        shell("old", "Login flow", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("new", "Login redesign", { updatedAt: "2026-02-01T00:00:00.000Z" }),
        shell("self", "Login self"),
        shell("gone", "Login archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        shell("foreign", "Login elsewhere", { environmentId: otherEnv }),
        shell("nope", "Unrelated"),
      ],
      environmentId: env,
      excludeThreadId: ThreadId.make("self"),
      query: "LOGIN",
    });
    expect(items.map((item) => item.thread.threadId)).toEqual(["new", "old"]);
    expect(items[0]).toMatchObject({ type: "thread", label: "Login redesign" });
  });
});

it("offers other machines' chats when the caller names them", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Login here", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      shell("mac", "Login on the Mac", {
        environmentId: otherEnv,
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ],
    environmentId: env,
    excludeThreadId: null,
    query: "login",
    otherEnvironmentLabel: (id) => (id === otherEnv ? "MacBook" : null),
  });
  expect(items.map((item) => [item.thread.threadId, item.description])).toEqual([
    ["mac", "Chat on MacBook"],
    ["here", "Thread"],
  ]);
});

it("offers recent chats for bare @ in Overview, with working chats first", () => {
  const shells = [
    shell("old-working", "Login background", { updatedAt: "2026-01-01T00:00:00.000Z" }),
    shell("new-idle", "Login idle", { updatedAt: "2026-03-01T00:00:00.000Z" }),
    shell("new-working", "Login working", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    shell("old-idle", "Login old", { updatedAt: "2025-12-01T00:00:00.000Z" }),
    shell("foreign", "Login elsewhere", { environmentId: otherEnv }),
    shell("deleted", "Login deleted", { deletedAt: "2026-01-01T00:00:00.000Z" }),
    shell("archived", "Login archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const input = {
    shells,
    environmentId: env,
    excludeThreadId: null,
    allowEmptyQuery: true,
    workingThreadIds: new Set([ThreadId.make("old-working"), ThreadId.make("new-working")]),
  };
  expect(
    matchComposerThreadItems({ ...input, query: "" }).map((item) => item.thread.threadId),
  ).toEqual(["new-working", "old-working", "new-idle", "old-idle"]);
  expect(
    matchComposerThreadItems({ ...input, query: "LoGiN Wo" }).map((item) => item.thread.threadId),
  ).toEqual(["new-working"]);
  expect(
    matchComposerThreadItems({ ...input, query: "", limit: 2 }).map((item) => item.description),
  ).toEqual(["Working chat", "Working chat"]);
});

describe("a chat described in brackets", () => {
  const onMuse = { providerInstanceId: "muse", modelSelection: { model: "muse-wonder-1.0" } };
  const onClaude = {
    providerInstanceId: "claudeAgent",
    modelSelection: { model: "claude-fable-5-2" },
  };
  const shells = [
    shell("sim-muse", "Build a Black Hole Simulation", onMuse),
    shell("sim-claude", "Black Hole Stuff", onClaude),
    shell("bench", "Model speed tests", onMuse),
    shell("taxes", "Tax return questions", onClaude),
    shell("gone", "Black hole archive", { ...onMuse, archivedAt: "2026-01-02T00:00:00.000Z" }),
    shell("elsewhere", "Black hole on another Mac", { ...onMuse, environmentId: otherEnv }),
  ];
  const rank = (
    query: string,
    matches: Parameters<typeof rankComposerChatMentions>[0]["matches"] = [],
    extra: Partial<Parameters<typeof rankComposerChatMentions>[0]> = {},
  ) =>
    rankComposerChatMentions({
      shells,
      environmentId: env,
      excludeThreadId: null,
      query,
      matches,
      ...extra,
    }).map((item) => item.thread.threadId);

  it("keeps only the words that can match something", () => {
    expect(chatMentionWords("the chat with Black Hole, muse wonder")).toEqual([
      "black",
      "hole",
      "muse",
      "wonder",
    ]);
    expect(chatMentionSearchQuery("chat with black hole muse wonder")).toBe(
      "black hole muse wonder",
    );
    // Filler alone is asked as written rather than as nothing.
    expect(chatMentionSearchQuery("  that one chat ")).toBe("that one chat");
    expect(chatMentionSearchQuery("word ".repeat(80))).toHaveLength(4);
  });

  it("puts the chat whose title and model carry the words first", () => {
    // Both black hole chats match the title; only one of them ran on Muse Wonder.
    expect(rank("chat with black hole muse wonder")).toEqual(["sim-muse", "sim-claude", "bench"]);
    expect(rank("black hole on claude")).toEqual(["sim-claude", "sim-muse", "taxes"]);
  });

  it("finds a chat by meaning when its title says nothing of the words", () => {
    const matches = [{ threadId: ThreadId.make("taxes") }, { threadId: ThreadId.make("bench") }];
    expect(rank("money owed to the government", matches)).toEqual(["taxes", "bench"]);
  });

  it("tells chats with one title apart by the model named, and says what each ran on", () => {
    const sameTask = [
      shell("on-ember", "Build a Black Hole Simulation (Muse Ember max)", {
        providerInstanceId: "muse",
        modelSelection: { model: "muse-ember-1.0" },
        updatedAt: "2026-01-09T00:00:00.000Z",
      }),
      shell("on-wonder", "Build Scientific Black Hole Simulation", {
        providerInstanceId: "muse",
        modelSelection: { model: "muse-wonder-full-1.0" },
      }),
      shell("on-gemini", "Build Scientific Black Hole Simulation", {
        providerInstanceId: "opencode",
        modelSelection: { model: "google-vertex/gemini-4-carbon" },
      }),
      shell("on-qwen", "Build Scientific Black Hole Simulation", {
        providerInstanceId: "acpRegistry_qwen_code",
        modelSelection: { model: "qwen-latest-series-invite-1102(openai)" },
      }),
    ];
    const found = rankComposerChatMentions({
      shells: sameTask,
      environmentId: env,
      excludeThreadId: null,
      query: "chat with black hole muse wonder",
      matches: [],
      workingThreadIds: new Set([ThreadId.make("on-gemini")]),
      age: (updatedAt) => (updatedAt.startsWith("2026-01-09") ? "1h ago" : null),
    });
    // Wonder is named by its model; Ember only shares "muse" with the description.
    expect(found.map((item) => [item.thread.threadId, item.description])).toEqual([
      ["on-wonder", "muse-wonder-full-1.0"],
      ["on-ember", "muse-ember-1.0 · 1h ago"],
      ["on-gemini", "Working · gemini-4-carbon"],
      ["on-qwen", "qwen-latest-series-invite-1102"],
    ]);
  });

  it("lets every word in the title outrank a chat that is only close in meaning", () => {
    const matches = [
      { threadId: ThreadId.make("taxes") },
      { threadId: ThreadId.make("sim-claude") },
    ];
    // Three of three words in a title beat two of three, which beat meaning alone.
    expect(rank("black hole stuff", matches)).toEqual(["sim-claude", "sim-muse", "taxes"]);
  });

  it("matches a word begun or given an ending, not a longer word that starts the same", () => {
    const titles = [
      shell("sim", "Black hole simulations"),
      shell("open", "Open the door"),
      shell("tax", "Tax return"),
    ];
    const found = (query: string) =>
      rankComposerChatMentions({
        shells: titles,
        environmentId: env,
        excludeThreadId: null,
        query,
        matches: [],
      }).map((item) => item.thread.threadId);
    expect(found("simul")).toEqual(["sim"]);
    expect(found("taxes")).toEqual(["tax"]);
    expect(found("opencode")).toEqual([]);
  });

  it("reads a possessive as its word and drops lone letters", () => {
    expect(chatMentionWords("marking a student's homework sheet")).toEqual([
      "marking",
      "student",
      "homework",
      "sheet",
    ]);
    expect(chatMentionWords("the agent\u2019s x plan for Qwen 4")).toEqual([
      "agent",
      "plan",
      "qwen",
      "4",
    ]);
    // "student's" once left an "s" behind that matched every title with an "'s" in it.
    const titles = [
      shell("grade", "Grade Worksheet in Aside"),
      shell("stuck", "Run stuck after the agent's turn ended"),
    ];
    const found = rankComposerChatMentions({
      shells: titles,
      environmentId: env,
      excludeThreadId: null,
      query: "marking a student's homework",
      matches: [{ threadId: ThreadId.make("grade") }],
    }).map((item) => item.thread.threadId);
    expect(found).toEqual(["grade"]);
  });

  it("puts the chat every word points at ahead of one the search ranks first", () => {
    const onEmber = { providerInstanceId: "opencode", modelSelection: { model: "muse-ember" } };
    const onWonderFull = {
      providerInstanceId: "muse",
      modelSelection: { model: "muse-wonder-full-1.0" },
    };
    const runs = [
      shell("ember", "Build a Black Hole Simulation (Muse Ember max, OpenCode)", onEmber),
      shell("wonder-old", "Build Scientific Black Hole Simulation", onWonderFull),
      shell("wonder-new", "Build Scientific Black Hole Simulation", {
        ...onWonderFull,
        updatedAt: "2026-01-05T00:00:00.000Z",
      }),
      shell("site", "Build a Black Hole Website", onClaude),
    ];
    const found = rankComposerChatMentions({
      shells: runs,
      environmentId: env,
      excludeThreadId: null,
      query: "chat with black hole muse wonder",
      // What was said in the Ember chat is closest; its model is not the one asked for.
      matches: [{ threadId: ThreadId.make("ember") }, { threadId: ThreadId.make("site") }],
    }).map((item) => item.thread.threadId);
    expect(found).toEqual(["wonder-new", "wonder-old", "ember", "site"]);
  });

  it("lets meaning lead when the titles carry only a stray word", () => {
    const titles = [
      shell("pet", "Patch pixel pet sheet"),
      shell("grade", "Grade Worksheet in Aside"),
    ];
    const found = rankComposerChatMentions({
      shells: titles,
      environmentId: env,
      excludeThreadId: null,
      query: "homework sheet marking",
      matches: [{ threadId: ThreadId.make("grade") }],
    }).map((item) => item.thread.threadId);
    expect(found).toEqual(["grade", "pet"]);
  });

  it("leaves out subagent chats, which repeat their lead's words", () => {
    const withSubagent = [
      shell("lead", "Black hole renders"),
      shell("child", "Black hole render review", {
        lineage: { relationshipToParent: "subagent" },
      }),
      shell("fork", "Black hole fork", { lineage: { relationshipToParent: "fork" } }),
    ];
    const found = rankComposerChatMentions({
      shells: withSubagent,
      environmentId: env,
      excludeThreadId: null,
      query: "black hole",
      matches: [{ threadId: ThreadId.make("child") }],
    }).map((item) => item.thread.threadId);
    expect([...found].sort()).toEqual(["fork", "lead"]);
  });

  it("leaves out archived chats, other machines and the chat being written in", () => {
    const found = rank("black hole", [], { excludeThreadId: ThreadId.make("sim-muse") });
    expect(found).toEqual(["sim-claude"]);
    // The server may still name them.
    expect(rank("zzz", [{ threadId: ThreadId.make("gone") }])).toEqual([]);
  });

  it("lists the chats in use and the latest ones before anything is described", () => {
    const dated = [
      shell("old", "Old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      shell("new", "New", { updatedAt: "2026-01-03T00:00:00.000Z" }),
      shell("busy", "Busy", { updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(
      rankComposerChatMentions({
        shells: dated,
        environmentId: env,
        excludeThreadId: null,
        query: "",
        matches: [],
        workingThreadIds: new Set([ThreadId.make("busy")]),
        limit: 2,
      }).map((item) => [item.thread.threadId, item.description]),
    ).toEqual([
      ["busy", "Working"],
      ["new", "Chat"],
    ]);
  });
});
