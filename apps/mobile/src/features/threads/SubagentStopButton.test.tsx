// @vitest-environment jsdom
import { EnvironmentId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ alert: vi.fn(), interrupt: vi.fn() }));
vi.mock("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => h.alert(...args) },
  Pressable: (props: { children: ReactNode; onPress: () => void; disabled?: boolean }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { interruptTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => h.interrupt }));
vi.mock("./threadAgentsPresentation", () => ({
  subagentStopTarget: () => ({ environmentId: "desk", threadId: "child" }),
}));
import { SubagentStopButton } from "./SubagentStopButton";

type AlertButton = { text: string; style?: string; onPress?: () => void };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.alert.mockReset();
  h.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  host = document.createElement("div");
  root = createRoot(host);
  act(() =>
    root.render(
      <SubagentStopButton
        environmentId={EnvironmentId.make("desk")}
        subagent={{ cancellationRequested: false } as unknown as OrchestrationV2Subagent}
        title="Pack tx9: files and forms"
      />,
    ),
  );
});
afterEach(() => act(() => root.unmount()));

it("asks before stopping, and a stray tap stops nothing", async () => {
  act(() => host.querySelector("button")!.click());
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledExactlyOnceWith(
    "Stop this subagent?",
    "Pack tx9: files and forms",
    expect.any(Array),
  );
  const buttons = h.alert.mock.calls[0]![2] as AlertButton[];
  expect(buttons.map((button) => [button.text, button.style])).toEqual([
    ["Keep running", "cancel"],
    ["Stop subagent", "destructive"],
  ]);
  // "Keep running" has nothing to run.
  expect(buttons[0]!.onPress).toBeUndefined();
  expect(host.textContent).toBe("Stop");

  await act(async () => buttons[1]!.onPress!());
  expect(h.interrupt).toHaveBeenCalledExactlyOnceWith({
    environmentId: "desk",
    input: { threadId: "child" },
  });
  expect(host.textContent).toBe("Stopping…");
});
