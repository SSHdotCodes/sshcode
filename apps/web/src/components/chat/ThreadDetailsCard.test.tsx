// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Activity, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const canvas = vi.hoisted(() => ({
  container: { width: 1600, height: 900 },
  lane: { padding: 48, minChatWidth: 640 },
  layout: { frame: null, overlapsDetailsCard: false },
  detailsCardTopInset: 0,
  reportDetailsCard: vi.fn(),
}));
vi.mock("./ChatCanvasContext", () => ({ useChatCanvas: () => canvas }));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const threadRef = { environmentId: EnvironmentId.make("mac"), threadId: ThreadId.make("draft") };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderCard(defaultInlineOpen: boolean) {
  await act(async () =>
    root.render(
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={{ current: null }}
        handle={PopoverCreateHandle()}
        onPresentationChange={() => {}}
        defaultInlineOpen={defaultInlineOpen}
      >
        {() => <p>Project scripts</p>}
      </ThreadDetailsCard>,
    ),
  );
}

it("keeps draft details off the canvas until opened and lets them close again", async () => {
  await renderCard(false);
  expect(container.querySelector('aside[aria-label="Thread details"]')).toBeNull();
  await act(async () =>
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true),
  );
  expect(container.querySelector("aside")?.textContent).toBe("Project scripts");
  await act(async () =>
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", false),
  );
  expect(container.querySelector("aside")).toBeNull();
});

it("preserves the default and remembered visibility for existing chats", async () => {
  await renderCard(true);
  expect(container.querySelector("aside")?.textContent).toBe("Project scripts");
  await act(async () =>
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", false),
  );
  await renderCard(true);
  expect(container.querySelector("aside")).toBeNull();
});

it("keeps its space on the canvas while an Activity hides it, and gives it back on unmount", async () => {
  const card = (
    <ThreadDetailsCard
      threadRef={threadRef}
      anchor={{ current: null }}
      handle={PopoverCreateHandle()}
      onPresentationChange={() => {}}
      defaultInlineOpen
    >
      {() => <p>Project scripts</p>}
    </ThreadDetailsCard>
  );
  await act(async () => root.render(<Activity mode="visible">{card}</Activity>));
  canvas.reportDetailsCard.mockClear();

  await act(async () => root.render(<Activity mode="hidden">{card}</Activity>));
  expect(canvas.reportDetailsCard).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  expect(canvas.reportDetailsCard).toHaveBeenLastCalledWith(null);
});
