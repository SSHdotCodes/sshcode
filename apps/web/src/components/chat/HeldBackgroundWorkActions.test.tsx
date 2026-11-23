import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  allowed: true,
  resume: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  remove: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => harness.allowed }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    resumeThreadQueue: { action: "resume" },
    cancelQueuedRun: { action: "remove" },
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: { action: "resume" | "remove" }) => harness[command.action],
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { HeldBackgroundWorkActions } from "./HeldBackgroundWorkActions";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  harness.allowed = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
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
it("resumes the child's queue and removes only the named queued run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(<HeldBackgroundWorkActions environmentId={environmentId} item={item} />);
  });
  const buttons = renderer!.root.findAllByType("button");
  expect(buttons.map((button) => button.props["aria-label"])).toEqual([
    "Resume held message: Discord levels",
    "Remove held message: Discord levels",
  ]);
  await act(() => buttons[0]!.props.onClick());
  expect(harness.resume).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: childThreadId },
  });
  await act(() => buttons[1]!.props.onClick());
  expect(harness.remove).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: childThreadId, runId },
  });
});
it("disables both controls when this environment does not grant queue writes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.allowed = false;
  await act(() => {
    renderer = create(<HeldBackgroundWorkActions environmentId={environmentId} item={item} />);
  });
  expect(renderer!.root.findAllByType("button").every((button) => button.props.disabled)).toBe(
    true,
  );
});
