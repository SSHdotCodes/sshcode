// @vitest-environment jsdom
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { MASCOT_REACTION_MS, type MascotMoment } from "@t3tools/client-runtime/mascot-moments";
import { harnessMascotForDriver } from "@t3tools/shared/harnessMascots";
import { act, createElement, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const readiness = vi.hoisted(() => ({
  ready: new Set<string>(),
  requested: [] as (string | null)[],
}));

// The width native layout would report for a measured text; null reports nothing.
const textLayout = vi.hoisted(() => ({ width: null as number | null }));
const nativeGlass = vi.hoisted(() => ({ enabled: false }));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  View: ({ children, testID }: { children: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  Text: ({
    children,
    onLayout,
  }: {
    children: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) => {
    useLayoutEffect(() => {
      if (onLayout && textLayout.width !== null) {
        onLayout({ nativeEvent: { layout: { width: textLayout.width } } });
      }
    });
    return createElement("span", null, children);
  },
  Pressable: ({ children }: { children: ReactNode }) => createElement("button", null, children),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("react-native-reanimated", () => {
  const animation = {
    duration: () => animation,
    delay: () => animation,
    reduceMotion: () => animation,
  };
  return {
    default: {
      View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
      createAnimatedComponent: (component: unknown) => component,
    },
    Easing: { out: (value: unknown) => value, cubic: () => {} },
    FadeIn: animation,
    FadeOut: animation,
    LayoutAnimationConfig: ({ children }: { children: ReactNode }) => children,
    ReduceMotion: { System: "system" },
    useAnimatedStyle: (style: () => unknown) => style(),
    useSharedValue: (value: unknown) => useState(() => ({ value }))[0],
    withTiming: (value: unknown) => value,
  };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../native/v5-workspace-context", async () => {
  const { createContext } = await import("react");
  return { NativeWorkspaceTabActivityContext: createContext(null) };
});
vi.mock("expo-glass-effect", () => ({
  GlassView: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-native-glass": true }, children),
  GlassContainer: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../native/native-glass", () => ({
  get NATIVE_LIQUID_GLASS_SUPPORTED() {
    return nativeGlass.enabled;
  },
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../browser/browser-preview-button", () => ({ BrowserPreviewButton: () => null }));
vi.mock("../devices/device-preview-button", () => ({ DevicePreviewButton: () => null }));
vi.mock("./HeldBackgroundWork", () => ({
  HeldBackgroundWorkActions: () => (
    <>
      <button>Resume</button>
      <button>Remove</button>
    </>
  ),
}));
vi.mock("./thread-work-log", () => ({ ShimmeringWorkContent: () => null }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("./LiveProgress", async () => {
  const { liveProgressCard } = await import("@t3tools/shared/liveProgress");
  return {
    LiveProgressBar: ({ fraction }: { fraction: number | null }) =>
      createElement("div", { "data-progress-bar": fraction === null ? "sweep" : "fill" }),
    // The card at the moment of the report, so the test needs no clock.
    useLiveProgressCard: (progress: Parameters<typeof liveProgressCard>[0] | undefined) =>
      progress === undefined ? null : liveProgressCard(progress, progress.reportedAt),
  };
});
vi.mock("../../components/HarnessMascot", async () => {
  const { createContext, use } = await import("react");
  const { harnessMascotForDriver } = await import("@t3tools/shared/harnessMascots");
  const HarnessMascotDriver = createContext<string | null>(null);
  const HarnessMascotAgentId = createContext<string | null>(null);
  return {
    HarnessMascotDriver,
    HarnessMascotAgentId,
    useHarnessMascotReady: (id: string | null) => {
      readiness.requested.push(id);
      return id !== null && readiness.ready.has(id);
    },
    HarnessMascot: () => {
      const mascot = harnessMascotForDriver(use(HarnessMascotDriver), use(HarnessMascotAgentId));
      return mascot && readiness.ready.has(mascot.id)
        ? createElement("span", { "data-mascot": mascot.id })
        : null;
    },
  };
});

import { HarnessMascotDriver, HarnessMascotAgentId } from "../../components/HarnessMascot";
import {
  compactWorkingLabel,
  FloatingWorkingControl,
  FLOATING_WORKING_CONTROL_COVERAGE,
  resolveFloatingWorkingReaction,
  teamBoardCapsuleLabel,
} from "./floating-working-control";
import { useTurnMascotMoments } from "./useTurnMascotState";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  textLayout.width = null;
  nativeGlass.enabled = false;
  readiness.ready = new Set(["grok"]);
  readiness.requested = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (
  driver: string | null,
  mascotState: "done" | "failed" | "idle",
  mascotMoment: MascotMoment | null = null,
  agentId: string | null = null,
) =>
  act(() =>
    root.render(
      <HarnessMascotDriver value={driver}>
        <HarnessMascotAgentId value={agentId}>
          <FloatingWorkingControl
            colorScheme="light"
            reaction={resolveFloatingWorkingReaction(
              mascotState,
              mascotMoment,
              harnessMascotForDriver(driver, agentId)?.id ?? null,
            )}
            status={null}
            devicePreview={null}
            browserPreview={null}
            showScrollToEnd={false}
            onScrollToEnd={() => {}}
            agents={null}
            onOpenAgents={() => {}}
            queuedCount={0}
            onOpenQueue={() => {}}
          />
        </HarnessMascotAgentId>
      </HarnessMascotDriver>,
    ),
  );

it.each(["done", "failed"] as const)(
  "does not flash a %s capsule for a missing or unsupported provider",
  (state) => {
    render(null, state);
    expect(host.innerHTML).toBe("");
    render("unregistered-driver", state);
    expect(host.innerHTML).toBe("");
  },
);

it("keeps result reactions when the inherited driver has a mascot", () => {
  render("grok", "done");
  expect(host.textContent).toBe("Done");
  expect(host.querySelector("[data-mascot]")).not.toBeNull();
  render("grok", "failed");
  expect(host.textContent).toBe("Stopped");
});

it("still shows a meaningful moment when its provider is unavailable", () => {
  render(null, "idle", { kind: "returned", text: "Ready for you ✨" });
  expect(host.textContent).toBe("Ready for you ✨");
  expect(host.querySelector("[data-mascot]")).toBeNull();
  render(null, "done", { kind: "milestone", text: "Five high fives ✨" });
  expect(host.textContent).toBe("Five high fives ✨");
});

it("shows the result label while the selected registry pet loads", () => {
  render("acpRegistry", "done", null, "kimi");
  expect(readiness.requested.at(-1)).toBe("kimi");
  expect(host.textContent).toBe("Done");
  expect(host.querySelector("[data-mascot]")).toBeNull();
  readiness.ready.add("kimi");
  render("acpRegistry", "done", null, "kimi");
  expect(host.textContent).toBe("Done");
  expect(host.querySelector("[data-mascot]")?.getAttribute("data-mascot")).toBe("kimi");
  render("acpRegistry", "failed", null, "mistral-vibe");
  expect(readiness.requested.at(-1)).toBe("mistral");
  expect(host.textContent).toBe("Stopped");
  expect(host.querySelector("[data-mascot]")).toBeNull();
  readiness.ready.add("mistral");
  render("acpRegistry", "failed", null, "mistral-vibe");
  expect(host.textContent).toBe("Stopped");
});

it.each([
  ["completed", "done", "Done", "acpRegistry"],
  ["interrupted", "failed", "Stopped", "acpRegistry"],
  ["completed", "done", null, "unregistered-driver"],
  ["idle", "idle", null, "acpRegistry"],
] as const)(
  "settles a %s turn as %s (label %s, provider %s) in its first commit",
  (result, state, label, driver) => {
    vi.useFakeTimers();
    nativeGlass.enabled = true;
    const frames: Array<{
      state: string;
      capsule: Element | null;
      coverage: number;
      text: string | null;
    }> = [];

    function Turn({ status }: { status: string }) {
      const working = status === "running";
      const mascot = useTurnMascotMoments("thread", working, false, status, "run");
      const workingStatus = working
        ? ({ kind: "working", startedAt: "2026-11-26T23:00:00.000Z" } as const)
        : null;
      const reaction = resolveFloatingWorkingReaction(
        mascot.state,
        mascot.moment,
        harnessMascotForDriver(driver, "kimi")?.id ?? null,
      );
      useLayoutEffect(() => {
        const capsule = host.querySelector("[data-native-glass]");
        frames.push({
          state: mascot.state,
          capsule,
          coverage:
            workingStatus !== null || reaction !== null ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
          text: capsule?.textContent ?? null,
        });
      });
      return (
        <FloatingWorkingControl
          colorScheme="dark"
          reaction={reaction}
          status={workingStatus}
          devicePreview={null}
          browserPreview={null}
          showScrollToEnd={false}
          onScrollToEnd={() => {}}
          agents={null}
          onOpenAgents={() => {}}
          queuedCount={0}
          onOpenQueue={() => {}}
        />
      );
    }

    const observe = (status: string) =>
      act(() =>
        root.render(
          <HarnessMascotDriver value={driver}>
            <HarnessMascotAgentId value="kimi">
              <Turn status={status} />
            </HarnessMascotAgentId>
          </HarnessMascotDriver>,
        ),
      );

    observe("running");
    const capsule = host.querySelector("[data-native-glass]");
    expect(capsule?.textContent).toContain("Working");
    frames.length = 0;
    observe(result);
    expect(frames[0]).toEqual({
      state,
      capsule: label === null ? null : capsule,
      coverage: label === null ? 0 : FLOATING_WORKING_CONTROL_COVERAGE,
      text: label,
    });
    if (label === null) {
      act(() => vi.advanceTimersByTime(MASCOT_REACTION_MS));
      expect(frames.every((frame) => frame.capsule === null && frame.coverage === 0)).toBe(true);
      return;
    }
    expect(frames.every((frame) => frame.capsule === capsule)).toBe(true);
    expect(frames.every((frame) => frame.coverage === FLOATING_WORKING_CONTROL_COVERAGE)).toBe(
      true,
    );
    expect(capsule?.textContent).toBe(label);
    expect(capsule?.querySelector("[data-mascot]")).toBeNull();
    readiness.ready.add("kimi");
    observe(result);
    expect(host.querySelector("[data-native-glass]")).toBe(capsule);
    expect(capsule?.querySelector("[data-mascot]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(MASCOT_REACTION_MS));
    expect(frames.at(-1)).toEqual({ state: "idle", capsule: null, coverage: 0, text: null });
  },
);

it("keeps meaningful moment text visible while its pet is loading", () => {
  render("acpRegistry", "done", { kind: "returned", text: "Ready for you ✨" }, "kimi");
  expect(host.textContent).toBe("Ready for you ✨");
  expect(host.querySelector("[data-mascot]")).toBeNull();
});

it("keeps a held-only bar visible with queue actions and no working claim", () => {
  act(() =>
    root.render(
      <FloatingWorkingControl
        colorScheme="light"
        reaction={null}
        status={{
          kind: "background",
          label: "Held: Discord levels · since Oct 27, 2026",
          accessibilityLabel: "Held: Discord levels · since Oct 27, 2026",
          waiting: false,
          running: false,
          held: {
            environmentId: EnvironmentId.make("remote"),
            item: {
              taskId: "send",
              kind: "subagent",
              label: "Discord levels",
              childThreadId: ThreadId.make("child"),
              held: { runId: RunId.make("queued"), since: "2026-10-27T12:00:00.000Z" },
            },
          },
        }}
        devicePreview={null}
        browserPreview={null}
        showScrollToEnd={false}
        onScrollToEnd={() => {}}
        agents={null}
        onOpenAgents={() => {}}
        queuedCount={0}
        onOpenQueue={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain("Held: Discord levels · since Oct 27, 2026");
  expect(host.textContent).toContain("ResumeRemove");
  expect(host.textContent).not.toMatch(/Working|Running|Waiting on/);
});

it("swaps the rate for time left and draws a bar when the agent reports progress", () => {
  const renderWorking = (progress?: { value: never; onPress: () => void }) =>
    act(() =>
      root.render(
        <FloatingWorkingControl
          colorScheme="light"
          reaction={null}
          status={{
            kind: "working",
            startedAt: "2026-11-26T23:00:00.000Z",
            ...(progress === undefined ? {} : { progress }),
          }}
          devicePreview={null}
          browserPreview={null}
          showScrollToEnd={false}
          onScrollToEnd={() => {}}
          agents={null}
          onOpenAgents={() => {}}
          queuedCount={0}
          onOpenQueue={() => {}}
        />,
      ),
    );
  renderWorking();
  expect(host.textContent).toBe("Working 0s");
  expect(host.querySelector("[data-progress-bar]")).toBeNull();
  const at = Date.UTC(2026, 10, 26, 23, 2);
  renderWorking({
    value: {
      source: "report",
      startedAt: at - 120_000,
      reportedAt: at,
      stages: [{ title: "Build", status: "active", minutes: 8, startedAt: at }],
      updates: [],
    } as never,
    onPress: () => {},
  });
  expect(host.textContent).toBe("Working 0s · 8 min left");
  expect(host.querySelector("[data-progress-bar]")?.getAttribute("data-progress-bar")).toBe("fill");
});

it("shortens the team board label as other capsule segments join it", () => {
  const board = { postCount: 6, overlapCount: 1 };
  expect(teamBoardCapsuleLabel(board, { beside: null })).toEqual({
    lead: "Team board · 6 posts",
    overlaps: " · 1 overlap",
  });
  expect(teamBoardCapsuleLabel(board, { beside: "segments" })).toEqual({
    lead: "6 posts",
    overlaps: " · 1 overlap",
  });
  // Beside the working status and its live progress, only the counts stay.
  expect(teamBoardCapsuleLabel(board, { beside: "status" })).toEqual({
    lead: "6",
    overlaps: " · 1",
  });
  expect(teamBoardCapsuleLabel({ postCount: 1, overlapCount: 0 }, { beside: null })).toEqual({
    lead: "Team board · 1 post",
    overlaps: null,
  });
});

it("puts a question for the person ahead of the team board's counts", () => {
  const board = { postCount: 11, overlapCount: 1, questions: 1 };
  // The question replaces the board's name and post count, so the pill never cuts it off,
  // even at the largest standard text size.
  expect(teamBoardCapsuleLabel(board, { beside: null })).toEqual({
    lead: "",
    questions: "1 question for you",
    overlaps: " · 1 overlap",
  });
  expect(teamBoardCapsuleLabel(board, { beside: "segments" })).toEqual({
    lead: "",
    questions: "1 question for you",
    overlaps: " · 1 overlap",
  });
  // Beside the working status it stands alone: bare counts next to it would not read.
  expect(teamBoardCapsuleLabel(board, { beside: "status" })).toEqual({
    lead: "",
    questions: "1 for you",
    overlaps: null,
  });
  expect(
    teamBoardCapsuleLabel({ postCount: 4, overlapCount: 0, questions: 2 }, { beside: null }),
  ).toEqual({ lead: "", questions: "2 questions for you", overlaps: null });
  // No question: the label is what it was.
  expect(
    teamBoardCapsuleLabel({ postCount: 6, overlapCount: 1, questions: 0 }, { beside: null }),
  ).toEqual({ lead: "Team board · 6 posts", overlaps: " · 1 overlap" });
});

it("keeps the compact working text whole or drops it to elapsed alone", () => {
  const label = (fullWidth: number | null) =>
    compactWorkingLabel({ elapsed: "57s", detail: "3 min left", width: 120, fullWidth });
  expect(label(110)).toBe("57s · 3 min left");
  expect(label(120)).toBe("57s · 3 min left");
  // Too wide, or not measured yet: elapsed alone, never "57s · 3 mi…".
  expect(label(121)).toBe("57s");
  expect(label(null)).toBe("57s");
  expect(
    compactWorkingLabel({ elapsed: "57s", detail: undefined, width: 0, fullWidth: null }),
  ).toBe("57s");
});

it("beside team board counts, shows elapsed and time left without Working while they fit", () => {
  const at = Date.UTC(2026, 10, 26, 23, 2);
  const renderBoard = () =>
    act(() =>
      root.render(
        <FloatingWorkingControl
          colorScheme="light"
          reaction={null}
          status={{
            kind: "working",
            startedAt: "2026-11-26T23:00:00.000Z",
            progress: {
              value: {
                source: "report",
                startedAt: at - 120_000,
                reportedAt: at,
                stages: [{ title: "Build", status: "active", minutes: 3, startedAt: at }],
                updates: [],
              } as never,
              onPress: () => {},
            },
          }}
          teamBoard={{ postCount: 6, overlapCount: 1, unread: false, onPress: () => {} }}
          devicePreview={null}
          browserPreview={null}
          showScrollToEnd={false}
          onScrollToEnd={() => {}}
          agents={null}
          onOpenAgents={() => {}}
          queuedCount={0}
          onOpenQueue={() => {}}
        />,
      ),
    );
  // What a person sees: everything but the hidden measuring twin.
  const shown = () => {
    const copy = host.cloneNode(true) as HTMLElement;
    copy.querySelector('[data-testid="working-label-measure"]')?.remove();
    return copy.textContent;
  };
  renderBoard();
  expect(shown()).toBe("0s6 · 1");
  textLayout.width = 120;
  renderBoard();
  expect(shown()).toBe("0s · 3 min left6 · 1");
  // The whole compact text no longer fits beside the counts: elapsed alone.
  textLayout.width = 400;
  renderBoard();
  expect(shown()).toBe("0s6 · 1");
  expect(shown()).not.toContain("Working");
});
