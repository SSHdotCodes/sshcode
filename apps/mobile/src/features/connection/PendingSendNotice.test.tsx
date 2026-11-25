// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CommandId, EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ enqueue: vi.fn(), open: vi.fn() }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/pending-sends", () => {
  const sendsAtom = Atom.make([]).pipe(Atom.keepAlive);
  return {
    pendingSends: {
      sendsAtom,
      awaitingAckAtom: sendsAtom,
      enqueue: (...args: unknown[]) => h.enqueue(...args),
    },
    pendingSendMetadata: () => ({ id: "new-retry-id", createdAt: "2026-10-20T13:00:00.000Z" }),
  };
});
import { appAtomRegistry } from "../../state/atom-registry";
import { pendingSends } from "../../state/pending-sends";
import { PendingSendNotice } from "./PendingSendNotice";

const base = {
  id: CommandId.make("saved-id"),
  environmentId: EnvironmentId.make("desk"),
  threadId: ThreadId.make("thread"),
  createdAt: "2026-10-20T12:00:00.000Z",
};
let host: HTMLDivElement;
let root: Root;
function render(visibleRequestIds: RuntimeRequestId[] = []) {
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <PendingSendNotice
          environmentId={base.environmentId}
          threadId={base.threadId}
          visibleRequestIds={visibleRequestIds}
          onOpenSideChat={h.open}
        />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  appAtomRegistry.set(pendingSends.sendsAtom, []);
  h.open.mockReset();
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue(undefined);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it("shows a saved side question in the chat while its sheet is closed", () => {
  appAtomRegistry.set(pendingSends.sendsAtom, [
    { ...base, kind: "side-question", prompt: "Did my message arrive?" },
  ]);
  render();
  expect(host.textContent).toContain("waiting for network");
  expect(host.textContent).toContain("Did my message arrive?");
  act(() => host.querySelector("button")!.click());
  expect(h.open).toHaveBeenCalledOnce();
});

it("keeps a rejected answer visible after its question card disappears and offers a new attempt", async () => {
  appAtomRegistry.set(pendingSends.sendsAtom, [
    {
      ...base,
      kind: "user-input",
      requestId: RuntimeRequestId.make("card"),
      answers: { a: "Use the queued answer" },
      error: "Could not send",
    },
  ]);
  render([RuntimeRequestId.make("card")]);
  expect(host.textContent).toBe("");
  render();
  expect(host.textContent).toContain("Use the queued answer");
  await act(async () => host.querySelector("button")!.click());
  expect(h.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ id: "new-retry-id", answers: { a: "Use the queued answer" } }),
  );
  expect(h.enqueue.mock.calls[0]![0].error).toBeUndefined();
});
