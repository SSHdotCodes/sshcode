// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { collectThreadFindRanges, useThreadFindHighlights } from "./threadFindHighlights";

function Probe(props: Parameters<typeof useThreadFindHighlights>[0]) {
  useThreadFindHighlights(props);
  return null;
}

let root: Root;
let host: HTMLElement;
let container: HTMLElement;
const onActiveRange = vi.fn();
const activeRanges = () => [
  ...(CSS.highlights.get("t3-thread-find-active") as unknown as Set<Range>),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 100));
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return this.startContainer.parentElement!.getBoundingClientRect();
    },
  });
  host = document.createElement("div");
  container = document.createElement("div");
  container.innerHTML =
    '<div data-timeline-row-id="first"><p data-thread-find-text>COD4 and COD4</p></div>' +
    '<div data-timeline-row-id="second"><p data-thread-find-text>COD4</p></div>';
  document.body.append(host, container);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("find highlight caching", () => {
  it("repaints nearby rows on scroll and keeps an offscreen active match", async () => {
    let scroll = 0;
    for (const [index, row] of [...container.children].entries()) {
      const bounds = () => new DOMRect(0, index * 1000 - scroll, 300, 100);
      row.getBoundingClientRect = bounds;
      row.firstElementChild!.getBoundingClientRect = bounds;
    }
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="second"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    const inactive = CSS.highlights.get("t3-thread-find")!;
    const selected = activeRanges()[0];
    expect(inactive.size).toBe(2);
    expect(container.lastElementChild!.contains(selected!.startContainer)).toBe(true);
    scroll = 1000;
    await act(async () => {
      container.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(inactive.size).toBe(0);
    expect(activeRanges()[0]).toBe(selected);
  });

  it("limits highlights within one long visible row while retaining its last match", async () => {
    const count = 2_000;
    const row = container.firstElementChild as HTMLElement;
    const paragraph = row.firstElementChild as HTMLElement;
    container.replaceChildren(row);
    paragraph.textContent = "x ".repeat(count);
    let scroll = 0;
    const rowBounds = () => new DOMRect(0, -scroll, 300, count * 20);
    for (const element of [row, paragraph]) {
      element.getBoundingClientRect = rowBounds;
      element.style.columnCount = "auto";
      element.style.columnWidth = "auto";
    }
    const measure = vi.fn(function (this: Range) {
      return new DOMRect(0, (this.startOffset / 2) * 20 - scroll, 10, 20);
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: measure,
    });
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="x"
          activeRowId="first"
          activeOccurrence={count - 1}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    const inactive = CSS.highlights.get("t3-thread-find")!;
    const offsets = () => [...inactive].map((range) => (range as Range).startOffset);
    expect(Math.min(...offsets())).toBe(0);
    expect(Math.max(...offsets())).toBe(20);
    expect(activeRanges()[0]?.startOffset).toBe((count - 1) * 2);
    expect(measure.mock.calls.length).toBeLessThan(100);
    scroll = count * 20 - 100;
    await act(async () => {
      container.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(Math.min(...offsets())).toBeGreaterThan((count - 20) * 2);
    expect(Math.max(...offsets())).toBe((count - 2) * 2);
    expect(activeRanges()[0]?.startOffset).toBe((count - 1) * 2);
  });

  it("checks only the old and new occurrence when cycling a message with many clipped matches", async () => {
    container.innerHTML =
      '<div data-timeline-row-id="first"><div data-thread-find-fold><p data-thread-find-text>' +
      "COD4 ".repeat(1500) +
      "</p></div></div>";
    const bounds = vi.fn(() => new DOMRect(0, 0, 40, 20));
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: bounds,
    });
    container.querySelector<HTMLElement>("[data-thread-find-fold]")!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 800, 100);
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    try {
      await act(async () => root.render(<Probe {...props} />));
      const inactive = CSS.highlights.get("t3-thread-find");
      const first = activeRanges()[0];
      bounds.mockClear();
      await act(async () => root.render(<Probe {...props} activeOccurrence={1} />));
      expect(bounds).toHaveBeenCalledTimes(2);
      expect(CSS.highlights.get("t3-thread-find")).toBe(inactive);
      expect(inactive?.size).toBe(1499);
      expect(inactive?.has(first!)).toBe(true);
      expect(activeRanges()[0]?.startOffset).toBe(5);
      expect(inactive?.has(activeRanges()[0]!)).toBe(false);
    } finally {
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("repaints for searchable text changes but not for timers outside it", async () => {
    const timer = document.createElement("span");
    container.firstElementChild!.append(timer);
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    onActiveRange.mockClear();
    await act(async () => {
      timer.textContent = "0:01";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onActiveRange).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector("p")!.append(" COD4");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onActiveRange).toHaveBeenCalled();
  });

  it("opens only the selected fold while reusing its cached text", async () => {
    container.innerHTML =
      '<div data-timeline-row-id="first"><div hidden><p data-thread-find-text>COD4 COD4</p></div></div>' +
      '<div data-timeline-row-id="second"><div hidden><p data-thread-find-text>COD4</p></div></div>';
    const folds = [...container.querySelectorAll<HTMLElement>("[hidden]")];
    for (const fold of folds)
      fold.addEventListener("beforematch", () => fold.removeAttribute("hidden"));
    const createRange = vi.spyOn(document, "createRange");
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(folds[0]?.hasAttribute("hidden")).toBe(false);
    expect(folds[1]?.hasAttribute("hidden")).toBe(true);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(1);
    const scanned = createRange.mock.calls.length;
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={1}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    expect(createRange).toHaveBeenCalledTimes(scanned);
    expect(activeRanges()[0]?.startOffset).toBe(5);
  });

  it("observes rows mounted synchronously while revealing the first match", async () => {
    container.replaceChildren();
    onActiveRange.mockImplementationOnce(() => {
      container.innerHTML =
        '<div data-timeline-row-id="first"><p data-thread-find-text>COD4</p></div>';
    });
    await act(async () => {
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("rebuilds ranges when the list moves or recycles an existing row", async () => {
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await act(async () => root.render(<Probe {...props} />));
    const initial = activeRanges()[0];
    const row = container.querySelector<HTMLElement>('[data-timeline-row-id="first"]')!;
    await act(async () => {
      row.remove();
      container.append(row);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()[0]).not.toBe(initial);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    await act(async () => {
      row.dataset.timelineRowId = "recycled";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()).toHaveLength(0);
    await act(async () => root.render(<Probe {...props} activeRowId="recycled" />));
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("reuses unchanged text ranges on navigation and scans only the streaming row", async () => {
    const createRange = vi.spyOn(document, "createRange");
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await act(async () => root.render(<Probe {...props} />));
    expect(createRange).toHaveBeenCalledTimes(3);
    const initial = activeRanges()[0];
    await act(async () => root.render(<Probe {...props} activeOccurrence={1} />));
    expect(createRange).toHaveBeenCalledTimes(3);
    expect(activeRanges()[0]?.startOffset).toBe(9);
    await act(async () => root.render(<Probe {...props} />));
    expect(activeRanges()[0]).toBe(initial);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"] p')!.firstChild!.nodeValue =
        "COD4 COD4";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]).toBe(initial);
    await act(async () =>
      root.render(<Probe {...props} activeRowId="second" activeOccurrence={1} />),
    );
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(activeRanges()[0]?.startOffset).toBe(5);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"]')!.remove();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()).toHaveLength(0);
    expect(onActiveRange).toHaveBeenLastCalledWith(null);
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(2);
    await act(async () => root.render(<Probe {...props} query="missing" />));
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(0);
  });
});

function row(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  return container;
}

describe("collectThreadFindRanges", () => {
  it("keeps occurrence counts and jump targets separate across message kinds", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div data-timeline-row-id="user-message">
        <div data-thread-find-text>Inspect the <strong>timeline</strong> timeline</div>
        <button data-thread-find-ignore>Copy timeline</button>
      </div>
      <div data-timeline-row-id="assistant-message">
        <div data-thread-find-text><p>The Timeline is ready</p><pre><code>timeline()</code></pre></div>
      </div>
      <div data-timeline-row-id="proposed-plan">
        <div data-thread-find-text><ol><li>Check the timeline</li></ol></div>
      </div>`;
    expect(
      collectThreadFindRanges(container, "timeline").map(({ rowId, occurrence, range }) => [
        rowId,
        occurrence,
        range.toString(),
      ]),
    ).toEqual([
      ["user-message", 0, "timeline"],
      ["user-message", 1, "timeline"],
      ["assistant-message", 0, "Timeline"],
      ["assistant-message", 1, "timeline"],
      ["proposed-plan", 0, "timeline"],
    ]);
  });

  it("finds matches split across inline token spans, in order", () => {
    // Shiki-style tokens split one identifier over several text nodes.
    const container = row(
      "<pre><code><span>con</span><span>st</span> a = <span>c</span>onst; const</code></pre>",
    );
    const ranges = collectThreadFindRanges(container, "const");
    expect(ranges.map((match) => [match.occurrence, match.range.toString()])).toEqual([
      [0, "const"],
      [1, "const"],
      [2, "const"],
    ]);
  });

  it("finds every match across thousands of token nodes", () => {
    const tokens = Array.from({ length: 4000 }, (_, i) => `<span>id</span><span>${i} </span>`);
    const container = row(`<pre><code>${tokens.join("")}</code></pre>`);
    const ranges = collectThreadFindRanges(container, "id");
    expect(ranges).toHaveLength(4000);
    expect(ranges.map((match) => match.occurrence)).toEqual([...ranges.keys()]);
    expect(ranges.every((match) => match.range.toString() === "id")).toBe(true);
  });
});
