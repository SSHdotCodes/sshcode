// @vitest-environment jsdom
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  allowed: true,
  resume: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  remove: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => harness.allowed }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: (event: { stopPropagation: () => void }) => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    resumeThreadQueue: { action: "resume" },
    cancelQueuedRun: { action: "remove" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { action: "resume" | "remove" }) => harness[command.action],
}));

import { HeldBackgroundWorkRow } from "./HeldBackgroundWork";

let host: HTMLDivElement;
let root: Root;
const environmentId = EnvironmentId.make("remote");
const childThreadId = ThreadId.make("child");
const runId = RunId.make("queued-child-message");
const item = {
  taskId: "send",
  kind: "subagent" as const,
  label: "Discord levels",
  childThreadId,
  held: { runId, since: "2026-10-27T12:00:00.000Z" },
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  harness.allowed = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("shows a dated held message and targets the child's queue controls", async () => {
  const open = vi.fn();
  act(() =>
    root.render(<HeldBackgroundWorkRow environmentId={environmentId} item={item} onOpen={open} />),
  );
  expect(host.textContent).toContain("Held: Discord levels · since");
  expect(host.textContent).not.toMatch(/Running|Working/);
  const buttons = host.querySelectorAll("button");
  await act(async () => buttons[1]!.click());
  expect(harness.resume).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: childThreadId },
  });
  await act(async () => buttons[2]!.click());
  expect(harness.remove).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: childThreadId, runId },
  });
  expect(open).not.toHaveBeenCalled();
  act(() => buttons[0]!.click());
  expect(open).toHaveBeenCalledOnce();
});
it("keeps held messages readable without permission to change queues", () => {
  harness.allowed = false;
  act(() =>
    root.render(
      <HeldBackgroundWorkRow environmentId={environmentId} item={item} onOpen={() => {}} />,
    ),
  );
  expect(host.textContent).toContain("Held: Discord levels");
  expect([...host.querySelectorAll("button")].slice(1).every((button) => button.disabled)).toBe(
    true,
  );
});
