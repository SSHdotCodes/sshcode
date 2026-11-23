import { describe, expect, it, vi } from "vite-plus/test";
import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { createElement } from "react";
import { makeStreamingTimelineFixture, makeThreadFixture } from "./test-fixtures";
import { deriveTimelineEntriesFromVisibleTurnItemsWithState } from "./session-logic";
import { deriveMessagesTimelineRowsWithState } from "./components/chat/MessagesTimeline.logic";
import { createThreadProjectionCache } from "./lib/threadProjectionCache";
import {
  buildThreadActionItems,
  filterCommandPaletteGroups,
  presentCommandPaletteItem,
} from "./components/CommandPalette.logic";

function timing(name: string, run: () => unknown, iterations = 10) {
  run();
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) run();
    return (performance.now() - start) / iterations;
  }).sort((a, b) => a - b);
  console.info(name, samples[2]!.toFixed(4), "ms");
}

function history(count: number) {
  const fixture = makeStreamingTimelineFixture("The checks passed.");
  return Array.from({ length: count }, (_, index) => {
    const template = fixture.visibleTurnItems[index % fixture.visibleTurnItems.length]!;
    const id = TurnItemId.make(`item-${index}`);
    return {
      ...template,
      position: index,
      sourceItemId: id,
      item: {
        ...template.item,
        id,
        ...("messageId" in template.item ? { messageId: MessageId.make(`message-${index}`) } : {}),
      },
    };
  });
}

describe("bounded warm thread projections", () => {
  it.each([5_000, 10_000])(
    "keeps both outputs identical across switches with %i items",
    (count) => {
      const entries = createThreadProjectionCache(
        deriveTimelineEntriesFromVisibleTurnItemsWithState,
      );
      const rows = createThreadProjectionCache(deriveMessagesTimelineRowsWithState);
      const input = {
        visibleTurnItems: history(count),
        optimisticMessages: [],
        liveThoughts: true,
      };
      const first = entries("a", input);
      const rowInput = {
        timelineEntries: first.entries,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: true,
        expandedRunIds: new Set<RunId>(),
      };
      const initial = rows("a", rowInput, "/repo");
      entries("b", { ...input, visibleTurnItems: [] });
      rows("b", { ...rowInput, timelineEntries: [] }, "/repo");
      expect(entries("a", { ...input, optimisticMessages: [] })).toBe(first);
      expect(rows("a", { ...rowInput, expandedRunIds: new Set() }, "/repo")).toBe(initial);
      expect(first).toEqual(deriveTimelineEntriesFromVisibleTurnItemsWithState(input));
      expect(initial).toEqual(deriveMessagesTimelineRowsWithState(rowInput));
      timing(
        `warm-switch:${count}:before`,
        () => {
          const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
          return deriveMessagesTimelineRowsWithState({
            ...rowInput,
            timelineEntries: projection.entries,
          });
        },
        3,
      );
      timing(
        `warm-switch:${count}:after`,
        () => rows("a", { ...rowInput, timelineEntries: entries("a", input).entries }, "/repo"),
        100,
      );
      const expanded = {
        ...rowInput,
        expandedRunIds: new Set(
          input.visibleTurnItems.flatMap(({ item }) => (item.runId ? [item.runId] : [])),
        ),
      };
      expect(rows("a", expanded, "/repo")).toEqual(deriveMessagesTimelineRowsWithState(expanded));
      expect(rows("a", rowInput, "/other")).not.toBe(initial);
      const changed = { ...input, liveThoughts: false };
      expect(entries("a", changed)).toEqual(
        deriveTimelineEntriesFromVisibleTurnItemsWithState(changed),
      );
    },
  );

  it("evicts the least recently used thread after eight and isolates environments", () => {
    const derive = vi.fn((input: { value: number }) => ({ value: input.value }));
    const cache = createThreadProjectionCache(derive);
    const first = cache("env-a:thread", { value: 1 });
    for (let index = 0; index < 7; index++) cache(`env-b:${index}`, { value: index });
    expect(cache("env-a:thread", { value: 1 })).toBe(first);
    cache("env-c:thread", { value: 2 });
    expect(cache("env-a:thread", { value: 1 })).toBe(first);
    expect(cache("env-b:0", { value: 0 })).toEqual({ value: 0 });
    expect(derive).toHaveBeenCalledTimes(10);
  });
});

describe("palette metadata and visible presentation", () => {
  it("keeps eager row output, search order and callbacks while presenting only visible chats", async () => {
    const threads = Array.from({ length: 10_000 }, (_, index) =>
      makeThreadFixture({
        id: ThreadId.make(`thread-${index}`),
        title: `Keyboard navigation ${index}`,
      }),
    );
    let rendered = 0;
    const runThread = vi.fn(async () => {});
    const options = {
      threads,
      projectTitleById: new Map(),
      sortOrder: "updated_at" as const,
      icon: null,
      runThread,
      renderDescription: () => {
        rendered++;
        return createElement("span", null, "Workspace");
      },
      renderLeadingContent: () => createElement("span", null, "Status"),
    };
    const metadata = buildThreadActionItems({ ...options, deferPresentation: true });
    expect(rendered).toBe(0);
    const visible = metadata.slice(0, 12).map(presentCommandPaletteItem);
    expect(rendered).toBe(12);
    visible.forEach((item) => {
      const eager = buildThreadActionItems({
        ...options,
        threads: threads.filter((thread) => item.value === `thread:${thread.id}`),
      })[0]!;
      const { run: _run, ...output } = item;
      const { run: _eagerRun, ...expected } = eager;
      expect(output).toEqual(expected);
    });
    await visible[0]!.run();
    expect(runThread).toHaveBeenCalledWith(threads.at(-1));
    timing("palette-open:10000:before", () => buildThreadActionItems(options).slice(0, 12), 3);
    timing(
      "palette-open:10000:after",
      () =>
        buildThreadActionItems({ ...options, deferPresentation: true })
          .slice(0, 12)
          .map(presentCommandPaletteItem),
      3,
    );
    const search = (items = metadata, query = "kbnav") =>
      filterCommandPaletteGroups({
        activeGroups: [],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: items,
      });
    const result = search();
    expect(search()).toEqual(result);
    timing("palette-highlight:10000:before", () => search(metadata.slice()), 5);
    timing("palette-highlight:10000:after", () => search(), 100);
    expect(search(metadata, "thread-9999")[0]?.items[0]?.value).toBe("thread:thread-9999");
    expect(search(metadata, "no matching title")).toEqual([]);
  });
});
