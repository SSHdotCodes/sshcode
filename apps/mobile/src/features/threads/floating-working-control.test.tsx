// @vitest-environment jsdom
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const readiness = vi.hoisted(() => ({
  ready: new Set<string>(),
  requested: [] as (string | null)[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
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
    ReduceMotion: { System: "system" },
    useAnimatedStyle: (style: () => unknown) => style(),
    useSharedValue: (value: unknown) => useState(() => ({ value }))[0],
    withTiming: (value: unknown) => value,
  };
});
vi.mock("expo-glass-effect", () => ({ GlassView: () => null, GlassContainer: () => null }));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
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
import { FloatingWorkingControl } from "./floating-working-control";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  readiness.ready = new Set(["grok"]);
  readiness.requested = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const render = (
  driver: string | null,
  mascotState: "done" | "failed" | "idle",
  mascotMoment: Parameters<typeof FloatingWorkingControl>[0]["mascotMoment"] = null,
  agentId: string | null = null,
) =>
  act(() =>
    root.render(
      <HarnessMascotDriver value={driver}>
        <HarnessMascotAgentId value={agentId}>
          <FloatingWorkingControl
            colorScheme="light"
            mascotState={mascotState}
            mascotMoment={mascotMoment}
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

it("waits for the selected registry pet before showing a plain result capsule", () => {
  render("acpRegistry", "done", null, "kimi");
  expect(readiness.requested.at(-1)).toBe("kimi");
  expect(host.innerHTML).toBe("");
  readiness.ready.add("kimi");
  render("acpRegistry", "done", null, "kimi");
  expect(host.textContent).toBe("Done");
  expect(host.querySelector("[data-mascot]")?.getAttribute("data-mascot")).toBe("kimi");
  render("acpRegistry", "failed", null, "mistral-vibe");
  expect(readiness.requested.at(-1)).toBe("mistral");
  expect(host.innerHTML).toBe("");
  readiness.ready.add("mistral");
  render("acpRegistry", "failed", null, "mistral-vibe");
  expect(host.textContent).toBe("Stopped");
});

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
        mascotState="idle"
        mascotMoment={null}
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
