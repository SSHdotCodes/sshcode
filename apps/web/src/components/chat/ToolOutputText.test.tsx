// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ToolOutputDisclosureContext, ToolOutputText } from "./ToolOutputText";
import { MarkdownFindContext } from "./markdownFindContext";

let root: Root;
let host: HTMLDivElement;
const output = Array.from({ length: 200 }, (_, index) => `Output line ${index}`).join("\n");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("tool output disclosure", () => {
  it("renders a bounded preview and expands/collapses without toggling its parent row", async () => {
    const onToggle = vi.fn();
    const rowClick = vi.fn();
    await act(async () => {
      root.render(
        <ToolOutputDisclosureContext
          value={{ itemId: "tool", expandedEntries: new Set(), onToggle }}
        >
          <div onClick={rowClick} onKeyDown={rowClick}>
            <ToolOutputText text={output} />
          </div>
        </ToolOutputDisclosureContext>,
      );
    });
    const button = () => host.querySelector<HTMLButtonElement>("button")!;
    expect(host.textContent).toContain("Output line 11");
    expect(host.textContent).not.toContain("Output line 12");
    expect(button().textContent).toBe("Show more");
    await act(async () => button().click());
    expect(host.textContent).toContain("Output line 199");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(button().textContent).toBe("Show less");
    expect(onToggle).toHaveBeenLastCalledWith(false);
    await act(async () => {
      button().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button().click();
    });
    expect(host.textContent).not.toContain("Output line 199");
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("remembers each tool's output expansion across virtual row unmounts", async () => {
    const expandedEntries = new Set(["tool-a"]);
    const remount = async (itemId: string) => {
      await act(async () => root.render(null));
      await act(async () =>
        root.render(
          <ToolOutputDisclosureContext value={{ itemId, expandedEntries, onToggle: undefined }}>
            <ToolOutputText text={output} />
          </ToolOutputDisclosureContext>,
        ),
      );
    };
    const button = () => host.querySelector<HTMLButtonElement>("button")!;

    await remount("tool-a");
    expect(button().textContent).toBe("Show more");
    await act(async () => button().click());
    await remount("tool-a");
    expect(button().textContent).toBe("Show less");
    expect(host.textContent).toContain("Output line 199");

    await remount("tool-b");
    expect(button().textContent).toBe("Show more");
    expect(host.textContent).not.toContain("Output line 199");

    await remount("tool-a");
    await act(async () => button().click());
    await remount("tool-a");
    expect(button().textContent).toBe("Show more");
    expect(host.textContent).not.toContain("Output line 199");
    expect(expandedEntries).toEqual(new Set(["tool-a"]));
  });

  it("shows full live output, follows its tail, and respects a reader scrolling up", async () => {
    await act(async () => root.render(<ToolOutputText text={output} running />));
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toBe(output);
    const scroller = host.querySelector<HTMLElement>("[id]")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    await act(async () => root.render(<ToolOutputText text={output + "\nNext"} running />));
    expect(scroller.scrollTop).toBe(1_000);
    scroller.scrollTop = 100;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await act(async () => root.render(<ToolOutputText text={output + "\nMore"} running />));
    expect(scroller.scrollTop).toBe(100);
    await act(async () => root.render(<ToolOutputText text={output + "\nDone"} />));
    expect(host.textContent).not.toContain("Output line 199");
    expect(host.querySelector("button")?.textContent).toBe("Show more");
  });

  it("keeps folded text available to find and reveals it on beforematch", async () => {
    const disclosure = { itemId: "tool", expandedEntries: new Set<string>(), onToggle: undefined };
    await act(async () =>
      root.render(
        <ToolOutputDisclosureContext value={disclosure}>
          <MarkdownFindContext value>
            <ToolOutputText text={output} />
          </MarkdownFindContext>
        </ToolOutputDisclosureContext>,
      ),
    );
    const folded = host.querySelector<HTMLElement>("[data-thread-find-fold]")!;
    expect(folded.textContent).toBe(output);
    await act(async () => folded.dispatchEvent(new Event("beforematch")));
    expect(host.querySelector("[data-thread-find-fold]")).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Show less");
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <ToolOutputDisclosureContext value={disclosure}>
          <ToolOutputText text={output} />
        </ToolOutputDisclosureContext>,
      ),
    );
    expect(host.textContent).toContain("Output line 199");
    expect(host.querySelector("button")?.textContent).toBe("Show less");
  });
});
