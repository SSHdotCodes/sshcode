// @vitest-environment jsdom
import { ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { STATUS_CROSSFADE_EXIT_MS } from "../StatusCrossfade";
import { ResearchCard, SubagentCard } from "./SubagentCard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const baseProps = {
  title: "Investigate layout",
  detail: "Checking styles",
  provider: undefined,
  modelLabel: "Claude Sonnet",
  elapsed: "4s",
  threadId: ThreadId.make("sub-1"),
  onOpenThread: () => {},
  itemType: "subagent" as const,
};

describe("SubagentCard status crossfade", () => {
  it("does not crossfade on initial render, then crossfades live Running -> Completed and Failed transitions", async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(<SubagentCard {...baseProps} status="running" statusLabel="Running" />);
    });
    expect(container.querySelector("[data-status-crossfade-out]")).toBeNull();
    expect(container.querySelector("[data-status-crossfade-in]")).toBeNull();

    await act(async () => {
      root.render(<SubagentCard {...baseProps} status="completed" statusLabel="Completed" />);
    });
    const outgoingCompleted = container.querySelector("[data-status-crossfade-out]");
    const incomingCompleted = container.querySelector("[data-status-crossfade-in]");
    expect(outgoingCompleted?.textContent).toBe("Running");
    expect(outgoingCompleted?.innerHTML).toContain("text-info-foreground");
    expect(incomingCompleted?.textContent).toBe("Completed");
    expect(incomingCompleted?.innerHTML).toContain("text-success-foreground");

    await act(async () => {
      vi.advanceTimersByTime(STATUS_CROSSFADE_EXIT_MS);
    });
    expect(container.querySelector("[data-status-crossfade-out]")).toBeNull();

    await act(async () => {
      root.render(<SubagentCard {...baseProps} status="failed" statusLabel="Failed" />);
    });
    const outgoingFailed = container.querySelector("[data-status-crossfade-out]");
    const incomingFailed = container.querySelector("[data-status-crossfade-in]");
    expect(outgoingFailed?.textContent).toBe("Completed");
    expect(incomingFailed?.textContent).toBe("Failed");
    expect(incomingFailed?.innerHTML).toContain("text-destructive");
  });
});

describe("ResearchCard", () => {
  const research = {
    title: "X API pricing",
    modelLabel: "Haiku 5.5",
    elapsed: "1m 4s",
    threadId: ThreadId.make("research-1"),
    onOpenThread: () => {},
    failure: null,
  };

  it("shows what it is reading while it works", async () => {
    await act(async () => {
      root.render(
        <ResearchCard
          {...research}
          status="running"
          statusLabel="Researching…"
          progress="Reading docs.x.com pricing"
          preview={null}
          sources={{ sites: [], pages: 0 }}
          onOpenSource={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain("Researching…");
    expect(container.textContent).toContain("Reading docs.x.com pricing");
    expect(container.querySelector('[aria-label="Sources"]')).toBeNull();
  });

  it("shows the report's opening and its sites once done, and opens a site on click", async () => {
    const onOpenSource = vi.fn();
    const onOpenThread = vi.fn();
    const sites = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"].map((site) => ({
      site,
      url: `https://${site}/page`,
    }));
    await act(async () => {
      root.render(
        <ResearchCard
          {...research}
          onOpenThread={onOpenThread}
          status="completed"
          statusLabel="Research done"
          progress={null}
          preview="Full-archive search is on pay-per-use."
          sources={{ sites, pages: 9 }}
          onOpenSource={onOpenSource}
        />,
      );
    });
    expect(container.textContent).toContain("Research done");
    expect(container.textContent).toContain("Haiku 5.5 · 9 pages");
    expect(container.textContent).toContain("Full-archive search is on pay-per-use.");
    const chips = container.querySelectorAll('[aria-label="Sources"] a');
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
    expect(container.textContent).toContain("+2");
    await act(async () => (chips[1] as HTMLAnchorElement).click());
    expect(onOpenSource).toHaveBeenCalledWith("https://b.com/page", expect.anything());
    expect(onOpenThread).not.toHaveBeenCalled();
    await act(async () =>
      (
        container.querySelector('button[aria-label="Open X API pricing"]') as HTMLButtonElement
      ).click(),
    );
    expect(onOpenThread).toHaveBeenCalledWith("research-1");
  });
});
