// @vitest-environment jsdom
import { RunId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { ThreadFeedbackRun } from "./useThreadFeedback";

const harness = vi.hoisted(() => ({
  focused: true,
  appState: "active",
  listeners: new Set<(state: string) => void>(),
  impact: vi.fn(() => Promise.resolve()),
  notification: vi.fn(() => Promise.resolve()),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => harness.focused }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.listeners.add(listener);
      return { remove: () => harness.listeners.delete(listener) };
    },
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: harness.impact,
  notificationAsync: harness.notification,
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));

import { playThreadFeedback, useThreadFeedback } from "./useThreadFeedback";

let root: Root;
let runs: ReadonlyArray<ThreadFeedbackRun> | null;
let threadKey: string;
let composerError: { message: string; messageId?: string | null } | null;
let syncStatus: EnvironmentThreadStatus;
let connected: boolean;
let visible: boolean;
let supportsSyncMarker: boolean;
function Probe() {
  useThreadFeedback(threadKey, runs, composerError, {
    syncStatus,
    connected,
    visible,
    supportsSyncMarker,
  });
  return null;
}
function render() {
  act(() => root.render(<Probe />));
}
function setStatus(status: ThreadFeedbackRun["status"], runId = "run") {
  runs = [{ id: RunId.make(runId), status }];
  render();
}
function setAppState(state: string) {
  act(() => {
    harness.appState = state;
    harness.listeners.forEach((listener) => listener(state));
  });
}
function syncBaseline() {
  syncStatus = "synchronizing";
  render();
  syncStatus = "live";
  render();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.focused = true;
  harness.appState = "active";
  harness.impact.mockClear();
  harness.notification.mockClear();
  runs = null;
  syncStatus = "live";
  connected = true;
  visible = true;
  supportsSyncMarker = true;
  composerError = null;
  threadKey = "environment:thread";
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  expect(harness.listeners.size).toBe(0);
});

describe("focused thread feedback", () => {
  it("announces a completed turn once, after observing its work", () => {
    setStatus("running");
    syncBaseline();
    setStatus("waiting");
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("completed");
    setStatus("completed");
    expect(harness.notification.mock.calls).toEqual([["success"]]);
  });

  it("announces failure without treating interruptions or cancellations as failures", () => {
    setStatus("running");
    syncBaseline();
    setStatus("interrupted");
    setStatus("running");
    setStatus("cancelled");
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("running");
    setStatus("failed");
    expect(harness.notification.mock.calls).toEqual([["error"]]);
  });

  it("does not replay terminal states when opening a thread or receiving history", () => {
    setStatus("completed");
    setStatus("failed", "another-run");
    setStatus("completed", "another-run");
    threadKey = "other-environment:thread";
    setStatus("completed");
    runs = null;
    render();
    setStatus("completed");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("ignores outcomes behind another screen and starts fresh when returning", () => {
    setStatus("running");
    syncBaseline();
    harness.focused = false;
    render();
    setStatus("completed");
    harness.focused = true;
    render();
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("running", "next-run");
    setStatus("completed", "next-run");
    expect(harness.notification.mock.calls).toEqual([["success"]]);
  });

  it("does not replay a completion or send failure received while backgrounded", () => {
    setStatus("running");
    syncBaseline();
    setAppState("background");
    composerError = { message: "Delivery failed" };
    setStatus("failed");
    setAppState("active");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  describe.each(["background", "another screen", "hidden content"] as const)(
    "returning from %s",
    (interruption) => {
      function setVisible(shown: boolean) {
        if (interruption === "background") setAppState(shown ? "active" : "background");
        else {
          if (interruption === "another screen") harness.focused = shown;
          else visible = shown;
          render();
        }
      }

      it.each(["completed", "failed"] as const)(
        "keeps an observed run armed when it is still running on return, then %s",
        (status) => {
          setStatus("running");
          syncBaseline();
          setVisible(false);
          setStatus("running");
          setVisible(true);
          expect(harness.notification).not.toHaveBeenCalled();
          setStatus(status);
          setStatus(status);
          expect(harness.notification.mock.calls).toEqual([
            [status === "completed" ? "success" : "error"],
          ]);
        },
      );
    },
  );

  it("does not carry hidden armed runs across a thread switch, even with the same run id", () => {
    setStatus("running");
    syncBaseline();
    setAppState("background");
    threadKey = "other-environment:thread";
    setStatus("running");
    setAppState("active");
    setStatus("completed");
    threadKey = "environment:thread";
    setStatus("completed");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("rebaselines even when inactive and active events arrive together", () => {
    setStatus("running");
    syncBaseline();
    act(() => {
      harness.listeners.forEach((listener) => listener("inactive"));
      harness.listeners.forEach((listener) => listener("active"));
    });
    setStatus("completed");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("announces new composer failures, but not one already present on opening", () => {
    composerError = { message: "Old error" };
    render();
    expect(harness.notification).not.toHaveBeenCalled();
    composerError = null;
    render();
    composerError = { message: "Could not save message" };
    render();
    render();
    expect(harness.notification.mock.calls).toEqual([["error"]]);
  });

  it("coalesces a turn failure and delivery error in one update", () => {
    setStatus("running");
    syncBaseline();
    composerError = { message: "Delivery failed" };
    setStatus("failed");
    expect(harness.notification.mock.calls).toEqual([["error"]]);
  });

  it.each(["completed", "failed"] as const)(
    "announces run A's %s outcome when queued run B takes over",
    (status) => {
      runs = [
        { id: RunId.make("A"), status: "running" },
        { id: RunId.make("B"), status: "queued" },
      ];
      render();
      syncBaseline();
      runs = [
        { id: RunId.make("A"), status },
        { id: RunId.make("B"), status: "running" },
      ];
      render();
      render();
      expect(harness.notification.mock.calls).toEqual([
        [status === "completed" ? "success" : "error"],
      ]);
      runs = [runs[0]!, { id: RunId.make("B"), status: "completed" }];
      render();
      expect(harness.notification).toHaveBeenCalledTimes(2);
      expect(harness.notification).toHaveBeenLastCalledWith("success");
    },
  );

  it("does not treat a cached running shell or detail as observed live work", () => {
    syncStatus = "cached";
    setStatus("running");
    syncStatus = "synchronizing";
    setStatus("completed");
    syncStatus = "live";
    render();
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("running", "fresh");
    setStatus("completed", "fresh");
    expect(harness.notification.mock.calls).toEqual([["success"]]);
  });

  it("requires a live detail baseline even when the shell is connected", () => {
    syncStatus = "live";
    runs = null;
    render();
    setStatus("completed");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("rebaselines retained work across a reconnect before arming again", () => {
    setStatus("running");
    syncBaseline();
    connected = false;
    render();
    setStatus("completed");
    connected = true;
    render();
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("running", "new-run");
    setStatus("failed", "new-run");
    expect(harness.notification.mock.calls).toEqual([["error"]]);
  });

  it("rebaselines a same-connection detail resubscription and ignores its catch-up events", () => {
    setStatus("running");
    syncBaseline();
    syncStatus = "synchronizing";
    render();
    setStatus("failed");
    syncStatus = "live";
    render();
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("ignores work hidden behind the native workspace's other content", () => {
    setStatus("running");
    syncBaseline();
    visible = false;
    render();
    setStatus("completed");
    visible = true;
    render();
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("does not arm a retained live run inherited before the detail resume is confirmed", () => {
    setStatus("running", "retained");
    setStatus("completed", "retained");
    expect(harness.notification).not.toHaveBeenCalled();
    setStatus("running", "new-work");
    setStatus("completed", "new-work");
    expect(harness.notification.mock.calls).toEqual([["success"]]);
  });

  it("stays quiet on older servers without a replay completion marker", () => {
    supportsSyncMarker = false;
    setStatus("running");
    syncBaseline();
    setStatus("completed");
    setStatus("running", "another");
    setStatus("failed", "another");
    expect(harness.notification).not.toHaveBeenCalled();
  });

  it("deduplicates errors by message id and content, including outbox republication after clearing", () => {
    render();
    composerError = { messageId: "message-1", message: "Offline" };
    render();
    composerError = { messageId: "message-1", message: "Offline" };
    render();
    composerError = null;
    render();
    composerError = { messageId: "message-1", message: "Offline" };
    render();
    expect(harness.notification.mock.calls).toEqual([["error"]]);
    composerError = { messageId: "message-2", message: "Offline" };
    render();
    composerError = { messageId: "message-2", message: "Permission denied" };
    render();
    expect(harness.notification).toHaveBeenCalledTimes(3);
  });

  it("also deduplicates save failures that have no message id", () => {
    render();
    composerError = { message: "Could not save" };
    render();
    composerError = { message: "Could not save", messageId: null };
    render();
    expect(harness.notification.mock.calls).toEqual([["error"]]);
  });

  it("uses a light send impact and tolerates unavailable haptic feedback", async () => {
    harness.impact.mockRejectedValueOnce(new Error("Unavailable"));
    playThreadFeedback("sent");
    await Promise.resolve();
    expect(harness.impact).toHaveBeenCalledWith("light");
  });
});
