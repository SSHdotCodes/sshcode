// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  buildCardReplyContext,
  validateAndNormalizeCardInput,
  type CardSpec,
} from "@t3tools/shared/cards";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const linkedThreads = new Map<string, { id: ThreadId; title: string; deletedAt: null }>();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className, to }: { children: ReactNode; className?: string; to: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../../state/entities", () => ({
  useLinkedThreadShell: (ref: { threadId: ThreadId } | null) =>
    ref ? (linkedThreads.get(ref.threadId) ?? null) : null,
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_envId: unknown, resource: unknown) =>
    resource
      ? { _tag: "Success", url: "blob:test-card-image", expiresAt: Date.now() + 60_000 }
      : { _tag: "Idle" },
}));

import { AgentCard, AgentCardSkeleton } from "./AgentCard";

const envId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  linkedThreads.clear();
  vi.unstubAllGlobals();
});

function makeCard(raw: Record<string, unknown>): CardSpec {
  const result = validateAndNormalizeCardInput(raw);
  if (!result.ok) throw new Error(result.error);
  return result.card;
}

describe("AgentCard (Mac React)", () => {
  it("renders every block type, links only known chats, and opens the image viewer", () => {
    const knownChat = ThreadId.make("thread-known");
    linkedThreads.set(knownChat, { id: knownChat, title: "Phone build", deletedAt: null });
    const onImageExpand = vi.fn();

    const card = makeCard({
      title: "Overnight summary",
      subtitle: "All systems green",
      tone: "good",
      icon: "bot",
      blocks: [
        { text: "Checked **3 runs** overnight." },
        {
          rows: [
            {
              title: "Phone build",
              detail: "iOS 26.5",
              status: "done",
              chat: knownChat,
              value: "2m 10s",
            },
            { title: "Deleted chat", status: "idle", chat: "thread-missing", value: "—" },
          ],
        },
        {
          stats: [
            { label: "Tests", value: "412", delta: "+12" },
            { label: "Errors", value: "0", delta: "−3" },
          ],
        },
        { progress: { percent: 80, label: "Uploading", eta: "12s left" } },
        {
          chart: {
            kind: "bar",
            series: [{ label: "Throughput", points: [10, 22, 18, 30] }],
            xLabels: ["Q1", "Q2", "Q3", "Q4"],
          },
        },
        { image: { path: "shots/home.png", alt: "Home screenshot" } },
      ],
    });

    act(() => {
      root.render(
        <AgentCard
          itemId="item-1"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          workspaceRoot="/workspace"
          resolvedTheme="dark"
          onImageExpand={onImageExpand}
          onReply={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("Overnight summary");
    expect(container.textContent).toContain("All systems green");
    expect(container.textContent).toContain("412");
    expect(container.textContent).toContain("+12");
    expect(container.textContent).toContain("Uploading");
    expect(container.textContent).toContain("12s left");
    // Known chat renders as an <a> link; unknown chat is static text without a link.
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.some((a) => a.textContent?.includes("Phone build"))).toBe(true);
    expect(links.some((a) => a.textContent?.includes("Deleted chat"))).toBe(false);
    expect(container.textContent).toContain("Deleted chat");

    const imageBtn = container.querySelector('button[aria-label="Open Home screenshot"]');
    expect(imageBtn).toBeTruthy();
    act(() => {
      imageBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 0,
        images: [expect.objectContaining({ src: "blob:test-card-image", name: "Home screenshot" })],
      }),
    );
  });

  it("shows every weekday when the chart is wide enough", () => {
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return new DOMRect(0, 0, this.tagName === "SPAN" ? 25 : 300, 16);
      });
    const card = makeCard({
      title: "Weekly activity",
      blocks: [
        {
          chart: {
            kind: "bar",
            series: [{ label: "Runs", points: [1, 2, 3, 4, 5, 6, 7] }],
            xLabels: weekdays,
          },
        },
      ],
    });
    try {
      act(() => {
        root.render(
          <AgentCard
            itemId="weekly-chart"
            card={card}
            lockedState={{ locked: false }}
            environmentId={envId}
            threadId={threadId}
            workspaceRoot="/workspace"
            resolvedTheme="light"
            onImageExpand={vi.fn()}
            onReply={vi.fn()}
          />,
        );
      });
      const visibleDays = Array.from(container.querySelectorAll("span"))
        .filter((element) => getComputedStyle(element).visibility !== "hidden")
        .map((element) => element.textContent)
        .filter((label) => label !== null && weekdays.includes(label));
      expect(visibleDays).toEqual(weekdays);
    } finally {
      measure.mockRestore();
    }
  });

  it("sends action reply with hidden card-reply metadata and locks the card", async () => {
    const onReply = vi.fn(async (_reply: { text: string; context?: unknown }) => undefined);
    const card = makeCard({
      title: "Ready to merge?",
      actions: [
        { label: "Merge now", reply: "Merge the branch now.", style: "primary" },
        { label: "Hold", reply: "Hold off for now.", style: "plain" },
      ],
    });

    act(() => {
      root.render(
        <AgentCard
          itemId="item-action-1"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          workspaceRoot="/workspace"
          resolvedTheme="light"
          onImageExpand={vi.fn()}
          onReply={onReply}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const mergeBtn = buttons.find((b) => b.textContent?.includes("Merge now"))!;
    const holdBtn = buttons.find((b) => b.textContent?.includes("Hold"))!;

    await act(async () => {
      mergeBtn.click();
    });

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith({
      text: "Merge the branch now.",
      context: buildCardReplyContext({
        itemId: "item-action-1",
        kind: "action",
        actionIndex: 0,
        label: "Merge now",
      }),
    });
    expect(holdBtn.disabled).toBe(true);
  });

  it("tunes inputs and submits compact '<label>: <value>; ...' reply", async () => {
    const onReply = vi.fn(async (_reply: { text: string; context?: unknown }) => undefined);
    const card = makeCard({
      title: "Tune rollout",
      inputs: [
        {
          id: "env",
          kind: "choice",
          label: "Target",
          options: ["Staging", "Prod"],
          default: "Staging",
        },
        {
          id: "pct",
          kind: "slider",
          label: "Traffic",
          min: 0,
          max: 100,
          step: 25,
          unit: "%",
          default: 25,
        },
        { id: "flag", kind: "toggle", label: "Canary", default: false },
        { id: "note", kind: "text", label: "Note", default: "" },
      ],
      submit: "Apply",
    });

    act(() => {
      root.render(
        <AgentCard
          itemId="item-inputs-1"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          workspaceRoot="/workspace"
          resolvedTheme="dark"
          onImageExpand={vi.fn()}
          onReply={onReply}
        />,
      );
    });

    const prodRadio = Array.from(container.querySelectorAll('[role="radio"]')).find((el) =>
      el.textContent?.includes("Prod"),
    ) as HTMLButtonElement;
    const slider = container.querySelector('[role="slider"]') as HTMLElement;
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Apply"),
    )!;

    act(() => {
      prodRadio.click();
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Ship it");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      applyBtn.click();
    });

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]?.[0]?.text).toBe(
      "Target: Prod; Traffic: 50%; Canary: Off; Note: Ship it",
    );
  });

  it("renders streaming skeleton with title", () => {
    act(() => {
      root.render(<AgentCardSkeleton title="Preparing report…" />);
    });
    expect(container.textContent).toContain("Preparing report…");
  });
});
