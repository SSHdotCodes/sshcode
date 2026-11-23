import { replaceVisibleTurnItem } from "./state/orchestrationV2Projection.ts";
import {
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { threadMediaIndex, threadHasMedia } from "./threadMedia.ts";

const threadId = ThreadId.make("thread");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
function base(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}
function row(item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem {
  return {
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    visibility: "local",
    position: item.ordinal,
    item,
  };
}
const picture = {
  type: "image" as const,
  id: "pic",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const video = {
  type: "file" as const,
  id: "movie",
  name: "clip.mov",
  mimeType: "video/quicktime",
  sizeBytes: 10,
};
const user = {
  ...base("user"),
  type: "user_message" as const,
  messageId: MessageId.make("m1"),
  inputIntent: "turn_start" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
  text: "",
  attachments: [picture, video],
} satisfies OrchestrationV2TurnItem;
const assistant = {
  ...base("assistant"),
  type: "assistant_message" as const,
  messageId: MessageId.make("m2"),
  text: "![one](/repo/shot.png)\n![repeat](/repo/shot.png)\n[clip](https://cdn.example/movie.mp4)",
  streaming: false,
} satisfies OrchestrationV2TurnItem;
const tool = {
  ...base("tool"),
  type: "dynamic_tool" as const,
  toolName: "arbitrary",
  input: {},
  viewedImagePath: "/repo/shot.png",
  outputOmitted: true,
  outputImages: [{ mimeType: "image/png", unavailable: true }, { mimeType: "image/jpeg" }],
} satisfies OrchestrationV2TurnItem;

function index(items: OrchestrationV2TurnItem[]) {
  return threadMediaIndex(
    { visibleTurnItems: items.map(row), messages: [] },
    { workspaceRoot: "/repo" },
  );
}

describe("threadMediaIndex", () => {
  it("orders attachments, assistant images, videos, viewed files and arbitrary tool images by projected rows", () => {
    const media = index([user, assistant, tool]);
    expect(media.map(({ kind }) => kind)).toEqual([
      "image",
      "video",
      "image",
      "image",
      "video",
      "image",
      "image",
      "image",
    ]);
    expect(media.map(({ sourceItemId }) => sourceItemId)).toEqual([
      user.id,
      user.id,
      assistant.id,
      assistant.id,
      assistant.id,
      tool.id,
      tool.id,
      tool.id,
    ]);
    expect(media.slice(-2).map(({ target, unavailable }) => ({ target, unavailable }))).toEqual([
      {
        target: {
          type: "asset",
          resource: { _tag: "tool-output-image", threadId, itemId: tool.id, index: 0 },
        },
        unavailable: true,
      },
      {
        target: {
          type: "asset",
          resource: { _tag: "tool-output-image", threadId, itemId: tool.id, index: 1 },
        },
        unavailable: undefined,
      },
    ]);
  });
  it("deduplicates repeated projected rows and attachments while keeping repeated image occurrences", () => {
    const duplicateAttachment = { ...user, attachments: [picture, picture] };
    const media = index([duplicateAttachment, assistant, assistant]);
    expect(media).toHaveLength(4);
    expect(media[1]?.target).toEqual(media[2]?.target);
    expect(new Set(media.map(({ id }) => id)).size).toBe(media.length);
  });
  it("keeps ids stable when streaming appends text or another media occurrence", () => {
    const before = index([assistant]);
    const after = index([
      { ...assistant, text: `${assistant.text}\nMore text\n![new](/repo/new.png)` },
    ]);
    expect(after.slice(0, before.length).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
  });
  it("uses canonical message bodies when the projected item omits them", () => {
    const message = {
      id: assistant.messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      text: "![canonical](https://example.test/a.png)",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    const media = threadMediaIndex({
      messages: [message],
      visibleTurnItems: [row({ ...assistant, text: "" })],
    });
    expect(media.map(({ target }) => target)).toEqual([
      { type: "url", url: "https://example.test/a.png" },
    ]);
  });
  it("handles reference images, ignores code and non-video links, and retains extensionless image embeds", () => {
    const item = {
      ...assistant,
      text: "![ref][picture]\n\n[picture]: /repo/ref.png\n\n`![no](/repo/no.png)`\n\n[link](/repo/ordinary.png)\n\n![endpoint](https://example.test/render)",
    };
    expect(index([item]).map(({ name }) => name)).toEqual(["ref.png", "render"]);
  });
  it("indexes html image tags without reading tags inside code", () => {
    const item = {
      ...assistant,
      text: '<img src="https://cdn.test/image.png?a=1&amp;b=2"> ` <img src="https://cdn.test/no.png"> `',
    };
    expect(index([item]).map(({ target }) => target)).toEqual([
      { type: "url", url: "https://cdn.test/image.png?a=1&b=2" },
    ]);
  });
  it("never invents metadata for withheld output from an older server", () => {
    expect(index([{ ...tool, viewedImagePath: undefined, outputImages: undefined }])).toEqual([]);
  });
});

describe("lazy thread media", () => {
  it("keeps presence equal to the gallery through edits, removals, duplicates and workspace changes", () => {
    for (const items of [
      [],
      [user],
      [assistant],
      [tool],
      [user, user, assistant],
      [{ ...assistant, text: "Only text" }],
      [{ ...assistant, text: "```md\n![example](shot.png)\n```" }],
    ]) {
      const projection = { visibleTurnItems: items.map(row), messages: [] };
      for (const workspaceRoot of ["/repo", "/other", null]) {
        expect(threadHasMedia(projection, { workspaceRoot })).toBe(
          threadMediaIndex(projection, { workspaceRoot }).length > 0,
        );
      }
    }
    const projection = { visibleTurnItems: [row(assistant)], messages: [] };
    const first = threadMediaIndex(projection, { workspaceRoot: "/repo" });
    const streamed = threadMediaIndex(
      {
        ...projection,
        visibleTurnItems: [
          ...projection.visibleTurnItems,
          row({
            ...assistant,
            id: TurnItemId.make("later"),
            messageId: MessageId.make("later"),
            text: "More text",
          }),
        ],
      },
      { workspaceRoot: "/repo" },
    );
    expect(streamed).toEqual(first);
    expect(streamed[0]).toBe(first[0]);
  });

  it("answers for a closed gallery with 10,000 projected media rows", () => {
    const projection = {
      visibleTurnItems: Array.from({ length: 10_000 }, (_, index) =>
        row({
          ...assistant,
          id: TurnItemId.make(`item-${index}`),
          messageId: MessageId.make(`message-${index}`),
        }),
      ),
      messages: [],
    };
    expect(threadHasMedia(projection)).toBe(true);
    expect(threadMediaIndex(projection).length).toBeGreaterThan(0);
    // No timing assertion: a loaded release gate makes any limit on the full index a coin toss.
  }, 60_000);
});

describe("incremental media presence", () => {
  it.each([1, 3])(
    "does not read 999 old rows for %i coalesced chunks, including media added and removed",
    (chunks) => {
      let reads = 0;
      let visibleTurnItems = Array.from({ length: 1_000 }, (_, index) => {
        const item = {
          ...assistant,
          id: TurnItemId.make(`item-${index}`),
          messageId: MessageId.make(`message-${index}`),
          text: "Plain text",
        };
        return {
          ...row(item),
          get item() {
            if (index < 999) reads++;
            return item;
          },
        };
      });
      const messages: Parameters<typeof threadHasMedia>[0]["messages"] = [];
      const options = { workspaceRoot: "/repo" };
      expect(threadHasMedia({ visibleTurnItems, messages }, options)).toBe(false);
      for (const text of [
        "More plain text",
        "![new](https://cdn.test/new.png)",
        "Removed",
        "![again](/repo/again.png)",
      ]) {
        const item = visibleTurnItems[999]!.item;
        if (item.type !== "assistant_message") throw new Error("Expected assistant");
        for (let chunk = 0; chunk < chunks; chunk++)
          visibleTurnItems = replaceVisibleTurnItem(
            visibleTurnItems,
            999,
            row({ ...item, text }),
          ) as typeof visibleTurnItems;
        reads = 0;
        const present = threadHasMedia({ visibleTurnItems, messages }, options);
        expect(reads).toBe(0);
        expect(present).toBe(text.startsWith("!"));
        expect(present).toBe(threadMediaIndex({ visibleTurnItems, messages }, options).length > 0);
      }
    },
  );

  it("invalidates presence when canonical messages change with the same projected rows", () => {
    const visibleTurnItems = [row({ ...assistant, text: "No image" })];
    const message = {
      id: assistant.messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      text: "![canonical](https://example.test/a.png)",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    expect(threadHasMedia({ visibleTurnItems, messages: [] })).toBe(false);
    expect(threadHasMedia({ visibleTurnItems, messages: [message] })).toBe(true);
    expect(threadHasMedia({ visibleTurnItems, messages: [{ ...message, text: "Removed" }] })).toBe(
      false,
    );
  });
});

it("matches a full index through mixed presence and identity changes", () => {
  let rows = Array.from({ length: 12 }, (_, index) =>
    row({
      ...assistant,
      id: TurnItemId.make(`row-${index}`),
      messageId: MessageId.make(`message-${index}`),
      text: "Plain",
    }),
  );
  const messages: Parameters<typeof threadHasMedia>[0]["messages"] = [];
  for (let step = 0; step < 60; step++) {
    const index = (step * 7) % rows.length;
    const before = rows[index]!.item;
    if (before.type !== "assistant_message") throw new Error("Expected assistant");
    rows = replaceVisibleTurnItem(
      rows,
      index,
      row({
        ...before,
        messageId: step % 9 === 0 ? MessageId.make("duplicate") : before.messageId,
        text: step % 4 === 0 ? "![image](https://cdn.test/image.png)" : "Plain",
      }),
    ) as typeof rows;
    // Preserve real replacement metadata, including coalescing, for the next read.
    const current = replaceVisibleTurnItem(rows, index, rows[index]!);
    expect(threadHasMedia({ visibleTurnItems: current, messages })).toBe(
      threadMediaIndex({ visibleTurnItems: current, messages }).length > 0,
    );
    rows = current as typeof rows;
  }
});
