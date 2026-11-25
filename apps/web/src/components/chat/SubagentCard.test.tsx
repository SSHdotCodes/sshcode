// @vitest-environment jsdom
import { ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { STATUS_CROSSFADE_EXIT_MS } from "../StatusCrossfade";
import { SubagentCard } from "./SubagentCard";

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
