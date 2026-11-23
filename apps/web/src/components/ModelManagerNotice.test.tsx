// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  busy: null as { environmentId: string; threadId: string } | null,
  shell: null as {
    hasPendingApprovals: boolean;
    hasPendingUserInput: boolean;
    latestRun: { runId: string; status: string } | null;
  } | null,
  add: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.busy }));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: unknown) => (ref === null ? null : state.shell),
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "env" }));
vi.mock("../state/threads", () => ({
  environmentThreadShells: { modelManagerThreadRefAtom: () => null },
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add } }));

import { ModelManagerNotice } from "./ModelManagerNotice";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.busy = null;
  state.shell = null;
  state.add.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const redraw = () => act(async () => root.render(<ModelManagerNotice />));
const working = (runId: string) => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestRun: { runId, status: "running" },
});
const titles = () => state.add.mock.calls.map(([toast]) => (toast as { title: string }).title);

it("stays quiet until a model change it watched ends, then says so once", async () => {
  state.shell = { ...working("r0"), latestRun: { runId: "r0", status: "completed" } };
  await act(async () => root.render(<ModelManagerNotice />));
  // An old finished request is not announced when the app opens.
  expect(state.add).not.toHaveBeenCalled();

  state.busy = { environmentId: "env", threadId: "models:1" };
  state.shell = working("r1");
  await redraw();
  expect(state.add).not.toHaveBeenCalled();

  state.busy = null;
  state.shell = { ...working("r1"), latestRun: { runId: "r1", status: "completed" } };
  await redraw();
  await redraw();
  expect(titles()).toEqual(["Models finished"]);

  // The next request in the same chat is announced too.
  state.busy = { environmentId: "env", threadId: "models:1" };
  state.shell = working("r2");
  await redraw();
  state.busy = null;
  state.shell = { ...working("r2"), latestRun: { runId: "r2", status: "failed" } };
  await redraw();
  expect(titles()).toEqual(["Models finished", "Models stopped before finishing"]);
});

it("says once when the assistant is waiting for an answer", async () => {
  state.busy = { environmentId: "env", threadId: "models:1" };
  state.shell = { ...working("r1"), hasPendingUserInput: true };
  await act(async () => root.render(<ModelManagerNotice />));
  await redraw();
  expect(titles()).toEqual(["Models needs your answer"]);
  // Answered, then a second question: a second notice.
  state.shell = working("r1");
  await redraw();
  state.shell = { ...working("r1"), hasPendingApprovals: true };
  await redraw();
  expect(titles()).toEqual(["Models needs your answer", "Models needs your answer"]);
});
