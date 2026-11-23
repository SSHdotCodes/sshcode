import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

const harness = vi.hoisted(() => ({
  supportsTracking: true,
  scopes: new Set<string>(),
  visit: vi.fn(),
  unread: vi.fn(),
  alert: vi.fn(),
  haptic: vi.fn(() => Promise.resolve()),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("react-native", () => ({ Alert: { alert: harness.alert } }));
vi.mock("expo-haptics", () => ({ selectionAsync: harness.haptic }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { visit: harness.visit, markUnread: harness.unread },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "server-configs" }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && harness.scopes.has(environmentId),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          "environment",
          { environment: { capabilities: { threadVisitedTracking: harness.supportsTracking } } },
        ],
        [
          "other",
          { environment: { capabilities: { threadVisitedTracking: harness.supportsTracking } } },
        ],
      ]),
  },
}));

import { threadReadMenuAction, useThreadReadAction } from "./threadReadActions";

let thread: EnvironmentThreadShell;
beforeEach(() => {
  harness.supportsTracking = true;
  harness.scopes = new Set(["environment", "other"]);
  harness.visit.mockReset().mockResolvedValue({ _tag: "Success" });
  harness.unread.mockReset().mockResolvedValue({ _tag: "Success" });
  harness.alert.mockClear();
  harness.haptic.mockClear();
  thread = makeThreadShellFixture({
    environmentId: EnvironmentId.make("environment"),
    id: ThreadId.make("thread"),
    title: "A task",
    updatedAt: "2026-10-26T04:00:00.000Z",
    lastVisitedAt: "2026-10-26T03:00:00.000Z",
  });
});

describe("thread read actions", () => {
  it("offers both directions and hides unsupported server actions", () => {
    expect(threadReadMenuAction(thread, true)?.id).toBe("mark-read");
    expect(threadReadMenuAction({ lastVisitedAt: null }, false)?.id).toBe("mark-unread");
    expect(threadReadMenuAction({ lastVisitedAt: undefined }, false)).toBeNull();
  });

  it("marks only the observed server watermark read, without using the phone's clock", async () => {
    expect(await useThreadReadAction()(thread, "mark-read")).toBe(true);
    expect(harness.visit).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: thread.updatedAt },
    });
    expect(harness.unread).not.toHaveBeenCalled();
    expect(harness.haptic).toHaveBeenCalledOnce();
  });

  it("marks unread through the existing server command", async () => {
    expect(await useThreadReadAction()(thread, "mark-unread")).toBe(true);
    expect(harness.unread).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    expect(harness.visit).not.toHaveBeenCalled();
  });

  it("rechecks a revoked operation grant at invocation", async () => {
    const change = useThreadReadAction();
    harness.scopes.clear();
    expect(await change(thread, "mark-read")).toBe(false);
    expect(harness.visit).not.toHaveBeenCalled();
    expect(harness.alert).toHaveBeenCalledWith("Could not mark read", expect.any(String));
  });

  it("rechecks server support and rejects invalid read timestamps", async () => {
    const change = useThreadReadAction();
    harness.supportsTracking = false;
    expect(await change(thread, "mark-unread")).toBe(false);
    harness.supportsTracking = true;
    expect(await change({ ...thread, updatedAt: "invalid" }, "mark-read")).toBe(false);
    expect(harness.unread).not.toHaveBeenCalled();
    expect(harness.visit).not.toHaveBeenCalled();
  });

  it("reports a refused update and permits retry without success feedback", async () => {
    harness.unread.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Offline")),
    });
    const change = useThreadReadAction();
    expect(await change(thread, "mark-unread")).toBe(false);
    expect(harness.alert).toHaveBeenCalledWith("Could not mark unread", "Offline");
    expect(harness.haptic).not.toHaveBeenCalled();
    expect(await change(thread, "mark-unread")).toBe(true);
    expect(harness.haptic).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate taps per environment and thread while allowing other environments", async () => {
    let finish: ((value: { _tag: "Success" }) => void) | undefined;
    harness.visit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const change = useThreadReadAction();
    const first = change(thread, "mark-read");
    expect(await change(thread, "mark-unread")).toBe(false);
    expect(
      await change({ ...thread, environmentId: EnvironmentId.make("other") }, "mark-unread"),
    ).toBe(true);
    finish!({ _tag: "Success" });
    expect(await first).toBe(true);
    expect(await change(thread, "mark-unread")).toBe(true);
  });
});
