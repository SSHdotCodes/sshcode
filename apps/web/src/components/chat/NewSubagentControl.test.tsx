import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { NewSubagentControl } from "./NewSubagentControl";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => start }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startSubagent: "start" } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/entities", () => ({ readThreadShells: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-17T12:00" }));
vi.mock("./newSubagentModels", () => ({
  newSubagentCandidates: () => [{ instanceId: "codex", model: "model" }],
}));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => ({}) }));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => [],
  applyProviderInstanceSettings: () => [],
  sortProviderInstanceEntries: () => [],
}));
vi.mock("./ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("../ui/popover", () => ({
  Popover: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <>
      <button onClick={() => onOpenChange(!open)}>Toggle</button>
      {open && children}
    </>
  ),
  PopoverTitle: "h2",
  PopoverTrigger: () => null,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
}));

it("submits once when the popover is dismissed and reopened before the reply", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let acknowledge!: () => void;
  start.mockReturnValue(
    new Promise((resolve) => {
      acknowledge = () => resolve({ _tag: "Success" });
    }),
  );
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <NewSubagentControl
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("thread")}
        projectId={null}
        providers={[]}
        subagents={[]}
      />,
    );
  });
  const toggle = () => act(() => view.root.findAllByType("button")[0]!.props.onClick());
  const submit = () =>
    act(() => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  try {
    toggle();
    act(() =>
      view.root
        .findByType("textarea")
        .props.onChange({ currentTarget: { value: "Check the tests" } }),
    );
    submit();
    toggle();
    toggle();
    expect(view.root.findByType("textarea").props.value).toBe("Check the tests");
    submit();
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => acknowledge());
    act(() => view.unmount());
  }
});
