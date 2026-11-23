// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  useTimelinePromptNavigation,
  type TimelinePromptNavigation,
} from "./useTimelinePromptNavigation";

function Probe(props: Parameters<typeof useTimelinePromptNavigation>[0]) {
  const announcement = useTimelinePromptNavigation(props);
  return <output>{announcement?.text}</output>;
}

let host: HTMLDivElement;
let viewport: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  viewport = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

function setup() {
  let scroll = 350;
  const navigationRef = createRef<TimelinePromptNavigation>();
  const scrollToIndex = vi.fn(({ index }: { index: number }) => {
    scroll = index * 100 - 24;
    return Promise.resolve();
  });
  const listRef = {
    current: {
      getState: () => ({ scroll, positionAtIndex: (index: number) => index * 100 }),
      getScrollableNode: () => viewport,
      scrollToIndex,
    } as unknown as LegendListRef,
  };
  const items = [0, 2, 4].map((rowIndex) => ({
    id: `prompt-${rowIndex}`,
    rowIndex,
    userText: `prompt ${rowIndex}`,
    assistantText: null,
  }));
  const props = {
    navigationRef,
    listRef,
    items,
    threadKey: "thread",
    pageKey: "page-1",
    onManualNavigation: vi.fn(),
    historyControls: { hasMoreHistory: true, loading: false, error: null, onLoadEarlier: vi.fn() },
  };
  return {
    props,
    scrollToIndex,
    setScroll: (next: number) => {
      scroll = next;
    },
  };
}

describe("virtualized prompt navigation", () => {
  it("announces a bounded destination preview without moving composer focus", async () => {
    const { props } = setup();
    const text = "Inspect\n\n this pasted log. " + "Line details ".repeat(15);
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 80).trimEnd();
    const items = props.items.map((item, index) =>
      index === 1 ? { ...item, userText: text } : item,
    );
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    try {
      await act(async () => root.render(<Probe {...props} items={items} />));
      expect(host.textContent).toBe("");
      await act(async () => props.navigationRef.current?.(-1));
      expect(host.textContent).toBe(`Prompt 2 of 3: ${preview}…`);
      expect(document.activeElement).toBe(composer);
      await act(async () => props.navigationRef.current?.(1));
      expect(host.textContent).toBe("Prompt 3 of 3: prompt 4");
      expect(document.activeElement).toBe(composer);
    } finally {
      composer.remove();
    }
  });

  it("keeps announcements still during updates and clears them when switching threads", async () => {
    const { props, setScroll } = setup();
    await act(async () => root.render(<Probe {...props} />));
    await act(async () => props.navigationRef.current?.(-1));
    expect(host.textContent).toBe("Prompt 2 of 3: prompt 2");
    const textNode = host.querySelector("output")!.firstChild;
    const items = props.items.map((item) => ({ ...item, assistantText: "Streamed response" }));
    await act(async () => root.render(<Probe {...props} items={items} />));
    expect(host.querySelector("output")!.firstChild).toBe(textNode);
    setScroll(600);
    await act(async () => props.navigationRef.current?.(1));
    expect(host.textContent).toBe("Prompt 2 of 3: prompt 2");
    await act(async () =>
      root.render(<Probe {...props} items={items} threadKey="another-thread" />),
    );
    expect(host.textContent).toBe("");
    await act(async () => root.render(<Probe {...props} items={items} />));
    expect(host.textContent).toBe("");
  });

  it("uses mounted geometry when virtual estimates differ from the header offset", async () => {
    const { props, scrollToIndex, setScroll } = setup();
    setScroll(188);
    const state = props.listRef.current.getState();
    vi.spyOn(props.listRef.current, "getState").mockImplementation(() => ({
      ...state,
      elementAtIndex: (index: number) => {
        const element = document.createElement("div");
        element.getBoundingClientRect = () => new DOMRect(0, index * 100 + 12 - 188, 400, 50);
        return element;
      },
    }));
    await act(async () => root.render(<Probe {...props} />));
    await act(async () => props.navigationRef.current?.(-1));
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewOffset: 24 });
  });

  it("jumps previous and next without changing the timeline data", async () => {
    const { props, scrollToIndex } = setup();
    await act(async () => root.render(<Probe {...props} />));
    await act(async () => props.navigationRef.current?.(-1));
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 2, animated: false, viewOffset: 24 });
    await act(async () => props.navigationRef.current?.(1));
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 4, animated: false, viewOffset: 24 });
    await act(async () => props.navigationRef.current?.(1));
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("loads older history at the first prompt and jumps to the preceding prompt", async () => {
    const { props, scrollToIndex, setScroll } = setup();
    setScroll(0);
    await act(async () => root.render(<Probe {...props} />));
    await act(async () => props.navigationRef.current?.(-1));
    expect(props.historyControls.onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
    const items = [
      { ...props.items[0]!, id: "older-prompt", rowIndex: 0 },
      ...props.items.map((item) => ({ ...item, rowIndex: item.rowIndex + 2 })),
    ];
    await act(async () => root.render(<Probe {...props} items={items} pageKey="page-2" />));
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewOffset: 24 });
    expect(host.textContent).toBe("Prompt 1 of 4: prompt 0");
  });

  it("cancels a pending history jump when the reader scrolls or switches threads", async () => {
    const { props, scrollToIndex, setScroll } = setup();
    setScroll(0);
    await act(async () => root.render(<Probe {...props} />));
    await act(async () => props.navigationRef.current?.(-1));
    viewport.dispatchEvent(new Event("wheel"));
    const items = [{ ...props.items[0]!, id: "older-prompt", rowIndex: 0 }, ...props.items];
    await act(async () => root.render(<Probe {...props} items={items} pageKey="page-2" />));
    expect(scrollToIndex).not.toHaveBeenCalled();
    await act(async () => props.navigationRef.current?.(-1));
    await act(async () => root.render(<Probe {...props} items={items} threadKey="other-thread" />));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
