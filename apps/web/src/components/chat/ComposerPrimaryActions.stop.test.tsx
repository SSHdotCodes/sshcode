// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "none" }));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

let root: Root;
let container: HTMLDivElement;
const stop = vi.fn();
const stopReply = vi.fn();
async function render(
  summary: string | null,
  canOperateThread = true,
  run: { canInterrupt?: boolean; runId?: string | null } = {},
) {
  await act(async () =>
    root.render(
      <ComposerPrimaryActions
        compact={false}
        canOperateThread={canOperateThread}
        pendingAction={null}
        isRunning
        canInterrupt={run.canInterrupt ?? true}
        runId={run.runId ?? "run-1"}
        showPlanFollowUpPrompt={false}
        promptHasText={false}
        isSendBusy={false}
        sendDisabledReason={null}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={stop}
        onStopReply={stopReply}
        stopHelperSummary={summary}
        onImplementPlanInNewThread={() => {}}
      />,
    ),
  );
}
async function openStop() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Stop generation"]')!.click(),
  );
}
function menuItem(text: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
    item.textContent?.startsWith(text),
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stop.mockClear();
  stopReply.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function stopButton() {
  return container.querySelector<HTMLButtonElement>(
    '[aria-label="Stop generation"], [aria-label="Stopping"], [aria-label="Stopped"]',
  )!;
}
it("stops immediately when there are no helpers", async () => {
  await render(null);
  await openStop();
  expect(stop).toHaveBeenCalledOnce();
  expect(stopReply).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("offers Stop reply with named helpers and preserves Stop everything", async () => {
  await render("Keeps 2 subagents running: Review, Build");
  await openStop();
  expect(stop).not.toHaveBeenCalled();
  expect(menuItem("Stop reply").textContent).toContain("Review, Build");
  await act(async () => menuItem("Stop reply").click());
  expect(stopReply).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  await openStop();
  await act(async () => menuItem("Stop everything").click());
  expect(stop).toHaveBeenCalledOnce();
});
it("does not offer Stop without operate permission", async () => {
  await render("Keeps 1 subagent running: Build", false);
  await openStop();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(stop).not.toHaveBeenCalled();
  expect(stopReply).not.toHaveBeenCalled();
});
it("shows Stopping and ignores repeat clicks until the interrupt lands", async () => {
  await render(null);
  await openStop();
  expect(stop).toHaveBeenCalledOnce();
  expect(stopButton().getAttribute("aria-label")).toBe("Stopping");
  expect(stopButton().disabled).toBe(true);
  await act(async () => stopButton().click());
  expect(stop).toHaveBeenCalledOnce();

  // The run stopped: the clicked spot stays a disabled Stopped button, not Send or Resume.
  await render(null, true, { canInterrupt: false });
  expect(stopButton().getAttribute("aria-label")).toBe("Stopped");
  expect(stopButton().disabled).toBe(true);
});
it("drops the Stopped button shortly after the interrupt lands", async () => {
  vi.useFakeTimers();
  await render(null);
  await openStop();
  await render(null, true, { canInterrupt: false });
  expect(stopButton().getAttribute("aria-label")).toBe("Stopped");
  await act(async () => vi.advanceTimersByTime(1_500));
  expect(stopButton()).toBeNull();
});
it("offers Stop again when an interrupt never settles", async () => {
  vi.useFakeTimers();
  await render(null);
  await openStop();
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(stopButton().getAttribute("aria-label")).toBe("Stop generation");
  expect(stopButton().disabled).toBe(false);
  await act(async () => stopButton().click());
  expect(stop).toHaveBeenCalledTimes(2);
});
it("a new run starts with an enabled Stop", async () => {
  await render(null);
  await openStop();
  await render(null, true, { canInterrupt: false });
  await render(null, true, { runId: "run-2" });
  expect(stopButton().getAttribute("aria-label")).toBe("Stop generation");
  expect(stopButton().disabled).toBe(false);
});
it("Stop everything shows Stopping while Stop reply leaves the menu usable", async () => {
  await render("Keeps 1 subagent running: Build");
  await openStop();
  await act(async () => menuItem("Stop reply").click());
  expect(stopButton().getAttribute("aria-label")).toBe("Stop generation");
  await openStop();
  await act(async () => menuItem("Stop everything").click());
  expect(stop).toHaveBeenCalledOnce();
  expect(stopButton().getAttribute("aria-label")).toBe("Stopping");
});
