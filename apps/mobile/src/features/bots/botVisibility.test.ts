import { EnvironmentId, ThreadId, type Bot, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeBotEntries,
  botThreadKeys,
  sameEntries,
  withoutBotMatches,
  withoutBotThreads,
} from "./botVisibility";

const mac = EnvironmentId.make("mac");
const box = EnvironmentId.make("box");

const bot = (id: string, threadId: string): Bot => ({
  id,
  name: id,
  color: "blue",
  target: { instanceId: "codex" as Bot["target"]["instanceId"], model: "gpt" },
  permissions: {
    manageChats: true,
    answerQuestions: false,
    startSubagents: true,
    messageFirst: true,
  },
  threadId: ThreadId.make(threadId),
  createdAt: "2026-11-26T00:00:00.000Z",
});

const configs = (
  entries: ReadonlyArray<
    readonly [EnvironmentId, { readonly enabled?: boolean; readonly list?: Bot[] } | undefined]
  >,
  serverRunsBots = true,
) =>
  new Map(
    entries.map(
      ([id, bots]) =>
        [
          id,
          // Only the fields Bots read; the rest of a server config doesn't matter here.
          {
            environment: { capabilities: serverRunsBots ? { bots: true } : {} },
            settings: bots ? { bots } : {},
          } as unknown as ServerConfig,
        ] as const,
    ),
  );

const thread = (environmentId: EnvironmentId, id: string) => ({ environmentId, id });

describe("bot home chats", () => {
  it("leaves bot home chats out of lists, also while Bots are off", () => {
    const threads = [thread(mac, "pip-home"), thread(mac, "work"), thread(box, "pip-home")];
    const on = botThreadKeys(configs([[mac, { enabled: true, list: [bot("pip", "pip-home")] }]]));
    // Same thread id on another machine is a different chat.
    expect(withoutBotThreads(threads, on)).toEqual([thread(mac, "work"), thread(box, "pip-home")]);

    // Turning Bots off must not turn Pip's home chat into an ordinary chat.
    const off = botThreadKeys(configs([[mac, { enabled: false, list: [bot("pip", "pip-home")] }]]));
    expect(withoutBotThreads(threads, off)).toEqual([thread(mac, "work"), thread(box, "pip-home")]);
  });

  it("keeps the same array when no bot chat is listed", () => {
    const threads = [thread(mac, "work")];
    const keys = botThreadKeys(configs([[mac, { enabled: true, list: [bot("pip", "pip-home")] }]]));
    expect(withoutBotThreads(threads, keys)).toBe(threads);
  });

  it("drops search hits inside bot home chats", () => {
    const keys = botThreadKeys(configs([[mac, { enabled: true, list: [bot("pip", "pip-home")] }]]));
    const matches = [
      { environmentId: mac, threadId: "pip-home", snippet: "a" },
      { environmentId: mac, threadId: "work", snippet: "b" },
    ];
    expect(withoutBotMatches(matches, keys)).toEqual([matches[1]]);
  });

  it("lists bots only from machines where Bots are on and a bot exists", () => {
    const entries = activeBotEntries(
      configs([
        [mac, { enabled: true, list: [bot("pip", "a"), bot("juno", "b")] }],
        [box, { enabled: false, list: [bot("kit", "c")] }],
        [EnvironmentId.make("old"), undefined],
      ]),
    );
    expect(entries.map((entry) => `${entry.environmentId}/${entry.bot.id}`)).toEqual([
      "mac/pip",
      "mac/juno",
    ]);
    expect(activeBotEntries(configs([[mac, { enabled: true, list: [] }]]))).toEqual([]);
  });

  it("shows nothing for a server that doesn't run Bots, whatever its settings say", () => {
    const old = configs([[mac, { enabled: true, list: [bot("pip", "pip-home")] }]], false);
    expect(activeBotEntries(old)).toEqual([]);
    expect(botThreadKeys(old).size).toBe(0);
  });

  it("compares entries by value so a re-decoded config does not churn the strip", () => {
    const first = activeBotEntries(configs([[mac, { enabled: true, list: [bot("pip", "a")] }]]));
    const again = activeBotEntries(configs([[mac, { enabled: true, list: [bot("pip", "a")] }]]));
    expect(sameEntries(first, again)).toBe(true);
    const renamed = activeBotEntries(
      configs([[mac, { enabled: true, list: [{ ...bot("pip", "a"), name: "Pippa" }] }]]),
    );
    expect(sameEntries(first, renamed)).toBe(false);
  });
});
