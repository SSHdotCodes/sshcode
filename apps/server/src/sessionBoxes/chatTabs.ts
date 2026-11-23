/**
 * Chat tabs: named groups of related chats that clients show as a strip above the chat list.
 * The session title model files each new chat into a tab in the same reply as its title, and
 * a one-off pass files the chats there were before tabs. A chat the user files by hand (or a
 * tab they delete) is never moved by the model again. Shell rows carry each chat's tab as
 * `chatTab`. Saved in chat-tabs.json in the state dir.
 */
import {
  ChatTabsError,
  ChatTab,
  CHAT_TAB_ICON_SIZE,
  CHAT_TAB_ICON_PIXEL_BYTES,
  isChatTabEmoji,
  type ChatTabIcon,
  type ChatTabIconInput,
  cleanChatTabName as cleanTabName,
  ModelComparison,
  type ChatTabRef,
  type ChatTabsCommand,
} from "@t3tools/contracts";
import type { ThreadTitleTabs } from "@t3tools/provider-core/server/textGeneration";
import * as NodeZlib from "node:zlib";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { announceBoxChange } from "./boxNamerCache.ts";

const TABS_FILE = "chat-tabs.json";
/** Tabs offered to the title model, and titles shown for each. */
const PROMPT_TABS = 40;
const PROMPT_TITLES_PER_TAB = 4;

type TabRecord = ChatTab;

interface ChatRecord {
  /** The tab's name, null when the chat is in none. */
  readonly tab: string | null;
  readonly by: "model" | "user";
  /** The chat's title when it was filed, to show the model what a tab holds. */
  readonly title: string;
  readonly at: number;
}

export class ChatTabs extends Context.Service<ChatTabs, ReturnType<typeof make>["store"]>()(
  "t3/sessionBoxes/chatTabs",
) {}

export function make() {
  /** Tabs by folded name. */
  const tabs = new Map<string, TabRecord>();
  const chats = new Map<string, ChatRecord>();
  const comparisons = new Map<string, ModelComparison>();
  const comparisonByThread = new Map<string, ModelComparison>();
  let existingSorted = false;
  let onChange: (() => void) | null = null;
  let announcedTabs: readonly TabRecord[] = [];
  const listeners = new Set<() => void>();

  /** Owner metadata subscribers, independent of whether a tab has any chats yet. */
  function subscribeChatTabs(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function pngChunk(type: string, data: Uint8Array): Buffer {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, 4, "ascii");
    chunk.set(data, 8);
    chunk.writeUInt32BE(NodeZlib.crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  }

  /** Encode only our fixed RGBA pixels, so file metadata, SVG and uploaded paths never persist. */
  function encodeIcon(input: ChatTabIconInput): ChatTabIcon | null {
    if (input.kind === "emoji") return isChatTabEmoji(input.emoji) ? input : null;
    if (input.pixels.length !== (CHAT_TAB_ICON_PIXEL_BYTES * 4) / 3) return null;
    const pixels = Buffer.from(input.pixels, "base64");
    if (pixels.length !== CHAT_TAB_ICON_PIXEL_BYTES) return null;
    const stride = CHAT_TAB_ICON_SIZE * 4;
    const scanlines = Buffer.alloc(CHAT_TAB_ICON_SIZE * (stride + 1));
    for (let row = 0; row < CHAT_TAB_ICON_SIZE; row++) {
      scanlines.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(CHAT_TAB_ICON_SIZE);
    header.writeUInt32BE(CHAT_TAB_ICON_SIZE, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", NodeZlib.deflateSync(scanlines)),
      pngChunk("IEND", new Uint8Array()),
    ]);
    return { kind: "image", dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  }

  const fold = (name: string) => name.toLocaleLowerCase("en-US");

  function tabFor(name: string): TabRecord {
    const existing = tabs.get(fold(name));
    if (existing !== undefined) return existing;
    const position = Math.max(-1, ...[...tabs.values()].map((tab) => tab.position)) + 1;
    const created = { name, position };
    tabs.set(fold(name), created);
    return created;
  }

  /** Drops tabs no chat is in. */
  function pruneTabs() {
    const used = new Set<string>();
    for (const chat of chats.values()) if (chat.tab !== null) used.add(fold(chat.tab));
    for (const key of tabs.keys())
      if (!used.has(key) && tabs.get(key)?.keepEmpty !== true) tabs.delete(key);
  }

  function changed(threadIds: Iterable<string>) {
    pruneTabs();
    onChange?.();
    const catalog = chatTabs.list();
    if (
      catalog.length !== announcedTabs.length ||
      catalog.some((tab, index) => tab !== announcedTabs[index])
    ) {
      announcedTabs = catalog;
      for (const listener of listeners) listener();
    }
    for (const threadId of new Set(threadIds)) announceBoxChange(threadId);
  }

  function chatsIn(name: string): Array<readonly [string, ChatRecord]> {
    const key = fold(name);
    return [...chats].filter(([, chat]) => chat.tab !== null && fold(chat.tab) === key);
  }

  const fail = (message: string) => Effect.fail(new ChatTabsError({ message }));

  const chatTabs = {
    list(): readonly ChatTab[] {
      return [...tabs.values()].toSorted((left, right) => left.position - right.position);
    },
    comparison(threadId: string): ModelComparison | null {
      return comparisonByThread.get(threadId) ?? null;
    },
    comparisonById(id: string): ModelComparison | null {
      return comparisons.get(id) ?? null;
    },
    endComparison(id: string) {
      const group = comparisons.get(id);
      if (!group) return;
      comparisons.delete(id);
      for (const threadId of group.threadIds) comparisonByThread.delete(threadId);
      changed(group.threadIds);
    },
    get(threadId: string): ChatTabRef | null {
      const chat = chats.get(threadId);
      if (chat === undefined || chat.tab === null) return null;
      const tab = tabs.get(fold(chat.tab));
      return tab === undefined
        ? null
        : { name: tab.name, position: tab.position, manual: chat.by === "user" };
    },

    /** True once the chat has a place: a tab or none, from the model or the user. */
    isFiled(threadId: string): boolean {
      return chats.has(threadId);
    },

    /** The tabs offered to the title model, each with its latest chats' titles. */
    promptTabs(): ThreadTitleTabs {
      const titles = new Map<string, Array<{ title: string; at: number }>>();
      for (const chat of chats.values()) {
        if (chat.tab === null || chat.title.length === 0) continue;
        const key = fold(chat.tab);
        titles.set(key, [...(titles.get(key) ?? []), { title: chat.title, at: chat.at }]);
      }
      return [...tabs]
        .toSorted(([, left], [, right]) => left.position - right.position)
        .slice(0, PROMPT_TABS)
        .map(([key, tab]) => ({
          name: tab.name,
          chats: (titles.get(key) ?? [])
            .toSorted((left, right) => right.at - left.at)
            .slice(0, PROMPT_TITLES_PER_TAB)
            .map((entry) => entry.title),
        }));
    },

    /**
     * Files a chat where the title model put it (`""` for no tab). A chat already filed, by
     * the user or by the model, keeps its place.
     */
    fileByModel(input: { threadId: string; tab: string; title: string; now: number }) {
      const previous = chats.get(input.threadId);
      if (previous !== undefined) return;
      const name = cleanTabName(input.tab);
      chats.set(input.threadId, {
        tab: name.length === 0 ? null : tabFor(name).name,
        by: "model",
        title: input.title,
        at: input.now,
      });
      changed([input.threadId]);
    },

    /** Whether the one-off pass over the chats there were before tabs has run. */
    existingSorted(): boolean {
      return existingSorted;
    },
    markExistingSorted() {
      existingSorted = true;
      onChange?.();
    },

    /** Applies a change the user made. `titleOf` names chats being filed, for the model. */
    command(
      command: ChatTabsCommand,
      input: { readonly titleOf: (threadId: string) => string | null; readonly now: number },
    ): Effect.Effect<void, ChatTabsError> {
      return Effect.suspend(() => {
        switch (command.action) {
          case "create": {
            const name = cleanTabName(command.tab);
            if (name.length === 0) return fail("Choose another server name.");
            const tab = tabFor(name);
            tabs.set(fold(name), { ...tab, keepEmpty: true });
            changed([]);
            return Effect.void;
          }
          case "set-icon": {
            const tab = tabs.get(fold(command.tab));
            if (!tab) return fail("This server is no longer available.");
            const icon = command.icon === null ? null : encodeIcon(command.icon);
            if (command.icon !== null && icon === null) return fail("Choose a valid server icon.");
            const { icon: _previous, ...rest } = tab;
            tabs.set(fold(tab.name), { ...rest, ...(icon === null ? {} : { icon }) });
            changed([]);
            return Effect.void;
          }
          case "compare": {
            const group = command.comparison;
            if (
              group.threadIds.length < 2 ||
              group.threadIds.length > 4 ||
              new Set(group.threadIds).size !== group.threadIds.length
            ) {
              return fail("Choose two to four different chats.");
            }
            const existing = comparisons.get(group.id);
            if (
              existing &&
              existing.title === group.title &&
              existing.threadIds.length === group.threadIds.length &&
              existing.threadIds.every((id, index) => id === group.threadIds[index])
            )
              return Effect.void;
            if (existing || group.threadIds.some((id) => chatTabs.comparison(id) !== null)) {
              return fail("A chat is already in a comparison.");
            }
            comparisons.set(group.id, group);
            for (const threadId of group.threadIds) comparisonByThread.set(threadId, group);
            changed(group.threadIds);
            return Effect.void;
          }
          case "continue-comparison":
            return fail("Continue a comparison through thread management.");
          case "move": {
            const name = command.tab === null ? "" : cleanTabName(command.tab);
            if (command.tab !== null && name.length === 0) return fail("Choose another tab name.");
            const tab = name.length === 0 ? null : tabFor(name).name;
            for (const threadId of command.threadIds) {
              chats.set(threadId, {
                tab,
                by: "user",
                title: input.titleOf(threadId) ?? chats.get(threadId)?.title ?? "",
                at: input.now,
              });
            }
            changed(command.threadIds);
            return Effect.void;
          }
          case "rename": {
            const source = tabs.get(fold(command.tab));
            if (source === undefined) return fail(`There is no tab named ${command.tab}.`);
            const name = cleanTabName(command.to);
            if (name.length === 0) return fail("Choose another tab name.");
            const members = chatsIn(source.name);
            const target = tabs.get(fold(name));
            if (target !== undefined && target !== source) {
              // Renaming onto another tab merges into it, where that tab already sits.
              tabs.delete(fold(source.name));
              for (const [threadId, chat] of members) {
                chats.set(threadId, { ...chat, tab: target.name, by: "user" });
              }
            } else {
              tabs.delete(fold(source.name));
              tabs.set(fold(name), { ...source, name });
              for (const [threadId, chat] of members) chats.set(threadId, { ...chat, tab: name });
            }
            changed(members.map(([threadId]) => threadId));
            return Effect.void;
          }
          case "delete": {
            tabs.delete(fold(command.tab));
            const members = chatsIn(command.tab);
            for (const [threadId, chat] of members) {
              chats.set(threadId, { ...chat, tab: null, by: "user" });
            }
            changed(members.map(([threadId]) => threadId));
            return Effect.void;
          }
          case "reorder": {
            const moving = tabs.get(fold(command.tab));
            if (moving === undefined) return fail(`There is no tab named ${command.tab}.`);
            const order = [...tabs.values()]
              .filter((tab) => tab !== moving)
              .toSorted((left, right) => left.position - right.position);
            const before = command.before === null ? null : fold(command.before);
            const beforeIndex =
              before === null ? -1 : order.findIndex((tab) => fold(tab.name) === before);
            order.splice(beforeIndex === -1 ? order.length : beforeIndex, 0, moving);
            order.forEach((tab, position) => tabs.set(fold(tab.name), { ...tab, position }));
            changed(chats.keys());
            return Effect.void;
          }
        }
      });
    },
  };

  const ChatEntry = Schema.Struct({
    tab: Schema.NullOr(Schema.String),
    by: Schema.Literals(["model", "user"]),
    title: Schema.String,
    at: Schema.Number,
  });
  const TabsFile = Schema.Struct({
    version: Schema.Literal(1),
    existingSorted: Schema.Boolean,
    tabs: Schema.Array(ChatTab),
    chats: Schema.Record(Schema.String, ChatEntry),
    comparisons: Schema.optionalKey(Schema.Array(ModelComparison)),
  });
  const decodeTabs = Schema.decodeUnknownEffect(Schema.fromJsonString(TabsFile));
  const encodeTabs = Schema.encodeEffect(Schema.fromJsonString(TabsFile));

  /** Loads the saved tabs at startup and saves them as they change. */
  const load = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(config.stateDir, TABS_FILE);
    const saved = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeTabs), Effect.option);
    if (saved._tag === "Some") {
      existingSorted = saved.value.existingSorted;
      for (const tab of saved.value.tabs) tabs.set(fold(tab.name), tab);
      for (const [threadId, chat] of Object.entries(saved.value.chats)) chats.set(threadId, chat);
      for (const group of saved.value.comparisons ?? []) {
        comparisons.set(group.id, group);
        for (const threadId of group.threadIds) comparisonByThread.set(threadId, group);
      }
      pruneTabs();
    }
    const save = Effect.gen(function* () {
      const encoded = yield* encodeTabs({
        version: 1,
        existingSorted,
        tabs: [...tabs.values()],
        chats: Object.fromEntries(chats),
        comparisons: [...comparisons.values()],
      });
      yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: 0o600 });
      yield* fs.rename(`${file}.tmp`, file);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not save chat tabs.", { cause })),
    );
    const saves = yield* Queue.sliding<void>(1);
    // Saves coalesce; `dirty` lets shutdown write the last change instead of dropping it.
    let dirty = false;
    const flush = Effect.suspend(() => {
      if (!dirty) return Effect.void;
      dirty = false;
      return save;
    }).pipe(Effect.uninterruptible);
    onChange = () => {
      dirty = true;
      Queue.offerUnsafe(saves, undefined);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (onChange = null)).pipe(Effect.andThen(flush)),
    );
    yield* Queue.take(saves).pipe(Effect.andThen(flush), Effect.forever, Effect.forkScoped);
  });

  return { store: { ...chatTabs, subscribe: subscribeChatTabs }, load };
}

export const layer = Layer.effect(
  ChatTabs,
  Effect.gen(function* () {
    const instance = make();
    yield* instance.load;
    return instance.store;
  }),
);
