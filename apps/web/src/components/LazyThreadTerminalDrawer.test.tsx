import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ loads: 0, mounts: 0 }));
vi.mock("../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./ThreadTerminalDrawer", async () => {
  state.loads += 1;
  const { useEffect, useState } = await import("react");
  return {
    default: function Terminal() {
      const [writes, setWrites] = useState(0);
      useEffect(() => {
        state.mounts += 1;
      }, []);
      return <button onClick={() => setWrites((count) => count + 1)}>{writes}</button>;
    },
  };
});

import LazyThreadTerminalDrawer from "./LazyThreadTerminalDrawer";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("loads only for visible or retained sessions and preserves the terminal across closure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const noop = () => {};
  const props = {
    threadRef: { environmentId: EnvironmentId.make("qa"), threadId: ThreadId.make("thread") },
    threadId: ThreadId.make("thread"),
    cwd: "/workspace",
    visible: false,
    height: 320,
    terminalIds: [] as string[],
    activeTerminalId: "",
    terminalGroups: [],
    activeTerminalGroupId: "",
    focusRequestId: 0,
    onSplitTerminal: noop,
    onSplitTerminalVertical: noop,
    onNewTerminal: noop,
    onActiveTerminalChange: noop,
    onCloseTerminal: noop,
    onHeightChange: noop,
    onAddTerminalContext: noop,
    keybindings: [],
  };
  await act(async () => {
    renderer = create(<LazyThreadTerminalDrawer {...props} />);
  });
  expect(renderer!.toJSON()).toBeNull();
  expect(state.loads).toBe(0);

  await act(async () => {
    renderer!.update(<LazyThreadTerminalDrawer {...props} visible />);
    await import("./ThreadTerminalDrawer");
  });
  expect(state.loads).toBe(1);
  expect(state.mounts).toBe(1);
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(renderer!.root.findByType("button").children).toEqual(["1"]);
  await act(async () => {
    renderer!.update(<LazyThreadTerminalDrawer {...props} />);
  });
  await act(async () => {
    renderer!.update(<LazyThreadTerminalDrawer {...props} visible />);
  });
  expect(renderer!.root.findByType("button").children).toEqual(["1"]);
  expect(state.mounts).toBe(1);

  await act(async () => {
    renderer!.unmount();
  });
  await act(async () => {
    renderer = create(<LazyThreadTerminalDrawer {...props} terminalIds={["retained-session"]} />);
  });
  expect(state.mounts).toBe(2);
});
