import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapBuckets,
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  resolveTimelinePromptJump,
} from "./timelineMinimapItems";
import { resolveTimelineMinimapIndexFromPointer } from "./MessagesTimeline.logic";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap buckets", () => {
  it("bounds a thousand prompts by pixel height, retaining every prompt exactly once", () => {
    for (const height of [16, 127.5, 480, 762]) {
      const buckets = deriveTimelineMinimapBuckets(1000, height);
      expect(buckets.length).toBeLessThanOrEqual(Math.floor(height / 8) + 1);
      expect(buckets[0]?.firstIndex).toBe(0);
      expect(buckets.at(-1)?.lastIndex).toBe(999);
      for (const [index, bucket] of buckets.entries()) {
        expect(bucket.lastIndex).toBeGreaterThanOrEqual(bucket.firstIndex);
        const previous = buckets[index - 1];
        if (previous) {
          expect(bucket.firstIndex).toBe(previous.lastIndex + 1);
          expect(((bucket.topPercent - previous.topPercent) * height) / 100).toBeGreaterThanOrEqual(
            8 - 0.000001,
          );
        }
      }
    }
  });

  it("maps bucket clicks to the first prompt, including the final bucket", () => {
    const items = deriveTimelineMinimapItems(
      rows(Array.from({ length: 1000 }, (_, index) => ["user", `Prompt ${index}`] as const)),
    );
    const buckets = deriveTimelineMinimapBuckets(items.length, 80);
    for (const bucket of buckets) {
      const index = resolveTimelineMinimapIndexFromPointer({
        itemCount: buckets.length,
        railTop: 20,
        railHeight: 80,
        pointerY: 20 + (bucket.topPercent * 80) / 100,
      });
      expect(index).not.toBeNull();
      const target = items[buckets[index!]!.firstIndex]!;
      expect(target.userText).toBe(`Prompt ${bucket.firstIndex}`);
      expect(target.rowIndex).toBe(bucket.firstIndex);
      expect(bucket.lastIndex - bucket.firstIndex + 1).toBeGreaterThan(1);
    }
  });

  it("keeps separate ticks when they fit, and waits for a measurable rail", () => {
    expect(deriveTimelineMinimapBuckets(3, 16)).toEqual([
      { firstIndex: 0, lastIndex: 0, topPercent: 0 },
      { firstIndex: 1, lastIndex: 1, topPercent: 50 },
      { firstIndex: 2, lastIndex: 2, topPercent: 100 },
    ]);
    expect(deriveTimelineMinimapBuckets(1000, 7)).toEqual([
      { firstIndex: 0, lastIndex: 999, topPercent: 0 },
    ]);
    expect(deriveTimelineMinimapBuckets(1000, 0)).toEqual([]);
    expect(deriveTimelineMinimapBuckets(0, 720)).toEqual([]);
  });
});

describe("timeline minimap previews", () => {
  it("jumps from the reading position, skipping an already aligned prompt", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "first"],
        ["assistant", "reply"],
        ["user", "second"],
        ["user", "third"],
      ]),
    );
    const position = (index: number) => [12, 100, 300, 600][index];
    expect(resolveTimelinePromptJump(items, position, 400, -1)?.userText).toBe("second");
    expect(resolveTimelinePromptJump(items, position, 300, -1)?.userText).toBe("first");
    expect(resolveTimelinePromptJump(items, position, 300, 1)?.userText).toBe("third");
    expect(resolveTimelinePromptJump(items, position, 600, 1)).toBeNull();
    expect(resolveTimelinePromptJump(items, () => undefined, 400, -1)).toBeNull();
  });

  it("excludes agent messages and question answers from the prompt rail", () => {
    const source = rows([
      ["user", "Mine"],
      ["user", "Agent"],
      ["user", "Answer"],
    ]);
    const agent = source[1]!;
    const answer = source[2]!;
    if (agent.kind !== "message" || answer.kind !== "message") throw new Error("Expected messages");
    const items = deriveTimelineMinimapItems([
      source[0]!,
      { ...agent, message: { ...agent.message, createdBy: "agent" } },
      { ...answer, message: { ...answer.message, id: MessageId.make("async-answer:question") } },
    ]);
    expect(items.map((item) => item.userText)).toEqual(["Mine"]);
  });
  it("retains prompt jump targets across prepended history and folded work", () => {
    const source = rows([
      ["user", "First prompt"],
      ["assistant", "First response"],
      ["user", "Second prompt"],
      ["assistant", "Second response"],
    ]);
    const work: MessagesTimelineRow = {
      kind: "turn-fold",
      id: "turn-fold:run",
      runId: RunId.make("run"),
      createdAt: source[0]!.createdAt!,
      label: "Worked for 3s",
      expanded: false,
    };
    const paged = [{ ...work, id: "older-turn" }, ...source.slice(0, 1), work, ...source.slice(1)];
    const items = deriveTimelineMinimapItems(paged);
    expect(items.map((item) => item.rowIndex)).toEqual([1, 4]);
    expect(items.map((item) => paged[item.rowIndex]!.id)).toEqual([source[0]!.id, source[2]!.id]);
    expect(items.map((item) => item.assistantText)).toEqual(["First response", "Second response"]);
  });

  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it("previews a quote, a context chip and a file link in the user's message as their text", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("assistant-1"),
      text: "The cache misses on a cold start.",
      start: 0,
      end: 33,
      prefix: "",
      suffix: "",
    });
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: `${quote}\nWhere do ${file} and [math.ts](src/math.ts) cover this?`,
      assistantText: null,
    });
    expect(preview?.userText).toBe(
      "The cache misses on a cold start. Where do README.md and math.ts cover this?",
    );
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });
});
