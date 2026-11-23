// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  configs: new Map<string, { settings: { workflowsBeta: boolean } }>(),
  writable: new Set<string>(),
  save: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.configs }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcSubscriptionAtomFamily: () => ({}),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: {},
  serverEnvironment: { updateSettings: {} },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => mocks.writable,
  readEnvironmentScope: (id: string) => mocks.writable.has(id),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
import { useWorkflowsEnabled } from "./state";

const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
let root: Root;
let current: ReturnType<typeof useWorkflowsEnabled>;
function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  const value = useWorkflowsEnabled(environmentId);
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.configs = new Map([
    [local, { settings: { workflowsBeta: true } }],
    [remote, { settings: { workflowsBeta: false } }],
  ]);
  mocks.writable = new Set([remote]);
  mocks.save.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("reads and changes the selected server's beta setting independently of other environments", async () => {
  await act(async () => root.render(<Probe environmentId={remote} />));
  expect(current[0]).toBe(false);
  expect(current[2]).toBe(true);
  current[1](true);
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: remote,
    input: { patch: { workflowsBeta: true } },
  });
  await act(async () => root.render(<Probe environmentId={local} />));
  expect(current[0]).toBe(true);
  expect(current[2]).toBe(false);
  current[1](false);
  expect(mocks.save).toHaveBeenCalledTimes(1);
});
