import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";
import { botSendText, botWakeText } from "@t3tools/shared/bots";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  botActivityLabel,
  botInboundNote,
  botStatus,
  botWakeNotesByRun,
  createBotThreadIdsAtom,
  createVisibleThreadSearchResultsAtomFamily,
  isShowCardTool,
  nextBotColor,
  nextBotName,
  parkedBotForThread,
  serverBotsView,
  withoutBotThreads,
} from "./bots.ts";

describe("nextBotName", () => {
  it("skips names already used, ignoring case", () => {
    expect(nextBotName([])).toBe("Pip");
    expect(nextBotName([{ name: "pip" }, { name: "Juno" }])).toBe("Kit");
    const all = ["Pip", "Juno", "Kit", "Ivy", "Rio", "Otto"].map((name) => ({ name }));
    expect(nextBotName(all)).toBe("Pip 2");
  });

  it("offers an unused color", () => {
    expect(nextBotColor([{ color: "blue" }])).toBe("indigo");
  });
});

describe("botStatus", () => {
  const idle = { working: false, needsYou: false };
  it("orders paused, needs you, working, watching", () => {
    const runtime = { watching: [{ threadId: "t" as never, events: [] }], waiting: 3 };
    expect(botStatus({ bot: { paused: true }, runtime, ...idle }).label).toBe(
      "Paused · 3 updates waiting",
    );
    expect(botStatus({ bot: {}, runtime, working: true, needsYou: true }).kind).toBe("needsYou");
    expect(botStatus({ bot: {}, runtime, working: true, needsYou: false }).label).toBe("Working…");
    expect(botStatus({ bot: {}, runtime, ...idle }).label).toBe("Watching 1 chat");
    expect(botStatus({ bot: {}, ...idle }).label).toBe("Ready");
  });
});

describe("botActivityLabel", () => {
  it("folds a turn's tools into plain words", () => {
    expect(
      botActivityLabel([
        "mcp__t3-code__t3_thread_read",
        "t3-code.t3_thread_read",
        "t3_thread_wait",
        "t3_thread_read",
        "t3_thread_send",
      ]),
    ).toBe("Checked 4 chats, messaged 1 chat");
    expect(botActivityLabel(["t3_thread_list"])).toBe("Checked the chat list");
    expect(botActivityLabel(["Bash", "Read"])).toBe("Took 2 steps");
    expect(botActivityLabel([])).toBe("");
  });
});

describe("createBotThreadIdsAtom", () => {
  it("keeps one set while the bot chats stay the same", () => {
    const registry = AtomRegistry.make();
    const bot = (threadId: string) => ({ threadId }) as never;
    const settings = Atom.make<{ bots?: { enabled: boolean; list: Array<never> } } | null>({
      bots: { enabled: true, list: [bot("a")] },
    });
    const ids = createBotThreadIdsAtom(() => settings)(EnvironmentId.make("env"));
    const dispose = registry.mount(ids);
    const first = registry.get(ids);
    expect([...first]).toEqual(["a"]);
    registry.set(settings, { bots: { enabled: true, list: [bot("a")] } });
    expect(registry.get(ids)).toBe(first);
    registry.set(settings, { bots: { enabled: true, list: [bot("a"), bot("b")] } });
    expect([...registry.get(ids)]).toEqual(["a", "b"]);
    const both = registry.get(ids);
    // Turning Bots off keeps their chats hidden: same chats, same set.
    registry.set(settings, { bots: { enabled: false, list: [bot("a"), bot("b")] } });
    expect(registry.get(ids)).toBe(both);
    registry.set(settings, { bots: { enabled: false, list: [] } });
    expect(registry.get(ids).size).toBe(0);
    dispose();
    registry.dispose();
  });
});

describe("withoutBotThreads", () => {
  it("drops bot home chats from search results on their own server only", () => {
    const hidden = (environmentId: string) => new Set(environmentId === "a" ? ["bot"] : []);
    const matches = [
      { environmentId: "a", threadId: "bot" },
      { environmentId: "a", threadId: "chat" },
      { environmentId: "b", threadId: "bot" },
    ];
    expect(withoutBotThreads(matches, hidden)).toEqual([matches[1], matches[2]]);
    const plain = [matches[1]!];
    expect(withoutBotThreads(plain, hidden)).toBe(plain);
  });
});

describe("createVisibleThreadSearchResultsAtomFamily", () => {
  it("leaves bot home chats out of every search that reads it", () => {
    const registry = AtomRegistry.make();
    const env = EnvironmentId.make("env");
    const match = (threadId: string) => ({ environmentId: env, threadId }) as never;
    const results = Atom.make({
      matches: [match("bot"), match("chat")],
      isLoading: false,
      failed: false,
    });
    const hidden = Atom.make<ReadonlySet<string>>(new Set(["bot"]));
    const visible = createVisibleThreadSearchResultsAtomFamily({
      resultsAtom: () => results,
      hiddenThreadIdsAtom: () => hidden,
      labelPrefix: "test",
    })("key");
    const dispose = registry.mount(visible);
    expect(registry.get(visible).matches).toEqual([match("chat")]);
    registry.set(hidden, new Set());
    expect(registry.get(visible)).toBe(registry.get(results));
    dispose();
    registry.dispose();
  });
});

describe("isShowCardTool", () => {
  it("matches the card tool under any MCP prefix and nothing else", () => {
    expect(isShowCardTool("show_card")).toBe(true);
    expect(isShowCardTool("mcp__t3-code__show_card")).toBe(true);
    expect(isShowCardTool("mcp__other__show_card")).toBe(true);
    expect(isShowCardTool("show_cards")).toBe(false);
    expect(isShowCardTool("t3_thread_list")).toBe(false);
    expect(isShowCardTool(null)).toBe(false);
  });
});

describe("botInboundNote", () => {
  it("reads wake notes and Send to messages, and leaves typed messages alone", () => {
    const wake = botWakeText([
      { kind: "event", threadId: "t1", title: "Phone build", event: "finished" },
      { kind: "message", threadId: "t2", title: "Server tests", text: "3 failed" },
    ]);
    expect(botInboundNote(wake)).toEqual([
      { kind: "event", threadId: "t1", title: "Phone build", event: "finished" },
      { kind: "message", threadId: "t2", title: "Server tests", text: "3 failed" },
    ]);
    expect(botInboundNote(botSendText({ threadId: "t3", title: "Docs", note: "Look" }))).toEqual([
      { kind: "message", threadId: "t3", title: "Docs", text: "Look" },
    ]);
    expect(botInboundNote("What's running right now?")).toBeNull();
  });
});

describe("botWakeNotesByRun", () => {
  it("finds each wake's full note through the run it started", () => {
    const items = [
      { kind: "event", threadId: "t1", title: "Phone build", event: "failed" },
    ] as const;
    const notes = botWakeNotesByRun(
      [
        { id: "run-wake", userMessageId: "message:bot:b1:1" },
        { id: "run-sent", userMessageId: "message:bot-send:b1:2" },
        { id: "run-typed", userMessageId: "message-3" },
      ],
      [
        { id: "message:bot:b1:1", text: botWakeText(items) },
        {
          id: "message:bot-send:b1:2",
          text: botSendText({ threadId: "t2", title: "D", note: "" }),
        },
        { id: "message-3", text: botWakeText(items) },
      ],
    );
    expect([...notes]).toEqual([["run-wake", items]]);
  });
});

describe("serverBotsView", () => {
  it("shows Bots only for servers that advertise them", () => {
    const bot = { id: "b1", threadId: "thread:bot:b1" };
    const config = (bots: boolean | undefined) =>
      ({
        environment: { capabilities: bots === undefined ? {} : { bots } },
        settings: { bots: { enabled: true, list: [bot] } },
      }) as never;
    // Older servers decode `bots` from defaults; without the capability they show nothing.
    expect(serverBotsView(config(undefined))).toEqual({ enabled: false, list: [], active: false });
    expect(serverBotsView(null).active).toBe(false);
    expect(serverBotsView(config(true))).toEqual({ enabled: true, list: [bot], active: true });
  });
});

describe("parkedBotForThread", () => {
  it("finds a kept bot's chat only while Bots are off", () => {
    const bot = { id: "b1", threadId: "thread:bot:b1" } as never;
    const off = { enabled: false, list: [bot], active: false };
    const on = { enabled: true, list: [bot], active: true };
    expect(parkedBotForThread(off, "thread:bot:b1")).toBe(bot);
    expect(parkedBotForThread(off, "thread:other")).toBeUndefined();
    expect(parkedBotForThread(on, "thread:bot:b1")).toBeUndefined();
    expect(parkedBotForThread(off, null)).toBeUndefined();
  });
});
