// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  buildCardReplyContext,
  validateAndNormalizeCardInput,
  type CardSpec,
} from "@t3tools/shared/cards";
import { act, type ReactNode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async () => undefined),
  navigate: vi.fn(),
  haptic: vi.fn(async () => undefined),
  threads: new Map<string, { id: ThreadId; title: string; deletedAt: null }>(),
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: mocks.haptic,
}));

vi.mock("expo-image", () => ({
  Image: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
    <img alt={accessibilityLabel ?? ""} />
  ),
}));

vi.mock("react-native-gesture-handler", () => {
  const chain = () => {
    const obj: Record<string, unknown> = {};
    for (const method of [
      "onBegin",
      "onUpdate",
      "onEnd",
      "onStart",
      "minDistance",
      "activeOffsetX",
      "failOffsetY",
      "enabled",
    ]) {
      obj[method] = () => obj;
    }
    return obj;
  };
  return {
    Gesture: { Tap: chain, Pan: chain, Race: () => chain() },
    GestureDetector: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) => (
      <div data-animated-style={JSON.stringify(style ?? {})}>{children}</div>
    ),
  },
  ReduceMotion: { System: "system" },
  Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
  runOnJS: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: <T,>(initial: T) => ({ value: initial }),
  withRepeat: <T,>(v: T) => v,
  withSequence: <T,>(v: T) => v,
  withTiming: <T,>(v: T) => v,
}));

vi.mock("react-native-svg", () => ({
  default: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
  Circle: () => <circle />,
  G: ({ children }: { children?: ReactNode }) => <g>{children}</g>,
  Line: () => <line />,
  Path: () => <path />,
  Rect: () => <rect />,
}));

vi.mock("react-native", () => ({
  View: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div data-class={className}>{children}</div>
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityRole,
    className,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    className?: string;
  }) => (
    <button
      type="button"
      disabled={Boolean(disabled)}
      aria-label={accessibilityLabel}
      data-role={accessibilityRole}
      data-class={className}
      onClick={() => {
        if (!disabled) onPress?.();
      }}
    >
      {children}
    </button>
  ),
  Switch: ({
    value,
    disabled,
    onValueChange,
    accessibilityLabel,
  }: {
    value?: boolean;
    disabled?: boolean;
    onValueChange?: (v: boolean) => void;
    accessibilityLabel?: string;
  }) => (
    <input
      type="checkbox"
      checked={Boolean(value)}
      disabled={Boolean(disabled)}
      aria-label={accessibilityLabel}
      onChange={(e) => onValueChange?.(e.target.checked)}
    />
  ),
  TextInput: ({
    value,
    editable = true,
    onChangeText,
    placeholder,
    accessibilityLabel,
  }: {
    value?: string;
    editable?: boolean;
    onChangeText?: (v: string) => void;
    placeholder?: string;
    accessibilityLabel?: string;
  }) => (
    <input
      type="text"
      value={value ?? ""}
      disabled={!editable}
      placeholder={placeholder}
      aria-label={accessibilityLabel}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
}));

vi.mock("../../components/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));

vi.mock("../../components/AppText", () => ({
  AppText: function MockAppText({
    children,
    onLayout,
    "aria-hidden": hidden,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    "aria-hidden"?: boolean;
  }) {
    useLayoutEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 25 } } });
    }, [onLayout]);
    return <span aria-hidden={hidden}>{children}</span>;
  },
}));

vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: ({
    label,
    options,
    onSelect,
  }: {
    label: string;
    options: readonly { label: string; value: string }[];
    onSelect: (v: string) => void;
  }) => (
    <div>
      <span>{label}</span>
      {options.map((opt) => (
        <button key={opt.value} type="button" onClick={() => onSelect(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({
    "--color-primary": "#3b82f6",
    "--color-primary-foreground": "#ffffff",
    "--color-icon-subtle": "#a1a1aa",
    "--color-chevron": "#a1a1aa",
    "--color-border-subtle": "#3f3f46",
    "--color-danger-foreground": "#ef4444",
    "--color-foreground": "#fafafa",
  }),
}));

vi.mock("../../lib/assetImageSource", () => ({
  assetImageSource: (_envId: unknown, _resource: unknown, url: string) => ({ uri: url }),
}));

vi.mock("../../lib/uuid", () => ({
  uuidv4: () => "test-card-uuid-1",
}));

vi.mock("../../state/assets", () => ({
  useAssetUrlState: (_envId: unknown, resource: unknown) =>
    resource ? { _tag: "Success", url: "https://local/card-image.png" } : { _tag: "Idle" },
}));

vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: ThreadId } | null) =>
    ref ? (mocks.threads.get(ref.threadId) ?? null) : null,
}));

vi.mock("../../state/thread-outbox", () => ({
  enqueueThreadOutboxMessage: mocks.enqueue,
}));

import { AgentCard, AgentCardSkeleton } from "./AgentCard";

const envId = EnvironmentId.make("env-mobile");
const threadId = ThreadId.make("thread-mobile");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  mocks.haptic.mockReset();
  mocks.threads.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

function makeCard(raw: Record<string, unknown>): CardSpec {
  const result = validateAndNormalizeCardInput(raw);
  if (!result.ok) throw new Error(result.error);
  return result.card;
}

describe("AgentCard (iPhone React Native)", () => {
  it("shows all seven chart labels when their measured widths fit", () => {
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const card = makeCard({
      title: "Weekly activity",
      blocks: [
        {
          chart: {
            kind: "bar",
            series: [{ label: "Runs", points: [1, 2, 3, 4, 5, 6, 7] }],
            xLabels: weekdays,
          },
        },
      ],
    });
    act(() => {
      root.render(
        <AgentCard
          itemId="weekly-chart"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          conversationThreadId={threadId}
          workspaceRoot="/workspace"
          themeAppearance="light"
          messageRunActive={false}
          canOperateMessage={true}
          onPressPreview={vi.fn()}
        />,
      );
    });
    const visibleDays = Array.from(host.querySelectorAll('span:not([aria-hidden="true"])'))
      .map((element) => element.textContent)
      .filter((label) => label !== null && weekdays.includes(label));
    expect(visibleDays).toEqual(weekdays);
  });

  it("renders all block types, opens known chats and image viewer, and stacks >2 actions", async () => {
    const knownChat = ThreadId.make("thread-known");
    mocks.threads.set(knownChat, { id: knownChat, title: "iOS build", deletedAt: null });
    const onOpenFilePreview = vi.fn();

    const card = makeCard({
      title: "Morning check",
      subtitle: "2 builds watched",
      tone: "good",
      icon: "bot",
      blocks: [
        { text: "Everything is ready." },
        {
          rows: [
            {
              title: "iOS build",
              detail: "Xcode 26",
              status: "done",
              chat: knownChat,
              value: "94s",
            },
            { title: "Deleted build", status: "failed", chat: "thread-missing", value: "err" },
          ],
        },
        { stats: [{ label: "Pass", value: "98%", delta: "+2%" }] },
        { progress: { percent: 75, label: "Uploading", eta: "10s" } },
        {
          chart: {
            kind: "line",
            series: [{ label: "Speed", points: [4, 8, 12] }],
            xLabels: ["1", "2", "3"],
          },
        },
        { image: { path: "shots/ios.png", alt: "iOS preview" } },
      ],
      actions: [
        { label: "Ship", reply: "Ship it now.", style: "primary" },
        { label: "Wait", reply: "Wait a bit.", style: "plain" },
        { label: "Cancel", reply: "Cancel release.", style: "danger" },
      ],
    });

    act(() => {
      root.render(
        <AgentCard
          itemId="item-m1"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          conversationThreadId={threadId}
          workspaceRoot="/repo"
          themeAppearance="dark"
          messageRunActive={true}
          canOperateMessage={true}
          onPressPreview={onOpenFilePreview}
        />,
      );
    });

    expect(host.textContent).toContain("Morning check");
    expect(host.textContent).toContain("2 builds watched");
    expect(host.textContent).toContain("98%");
    expect(host.textContent).toContain("Uploading");
    expect(host.textContent).toContain("Deleted build");

    // >2 actions render in a vertical stacked container (flex-col).
    const shipButton = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Ship"),
    )!;
    expect(shipButton.parentElement?.getAttribute("data-class")).toContain("flex-col");

    // Known chat navigates; unknown chat has no button press target.
    const knownRowBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("iOS build"),
    );
    expect(knownRowBtn).toBeTruthy();
    act(() => {
      knownRowBtn!.click();
    });
    expect(mocks.navigate).toHaveBeenCalledWith("Thread", {
      environmentId: envId,
      threadId: knownChat,
    });

    // Image tap opens existing image viewer.
    const imageBtn = host.querySelector(
      'button[aria-label="Open iOS preview"]',
    ) as HTMLButtonElement;
    expect(imageBtn).toBeTruthy();
    act(() => {
      imageBtn.click();
    });
    expect(onOpenFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "image",
        name: "iOS preview",
        uri: "https://local/card-image.png",
      }),
    );

    // Tapping an action while a run is active sends with dispatchMode: "steer" and triggers haptics.
    await act(async () => {
      shipButton.click();
    });
    expect(mocks.haptic).toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: envId,
        threadId,
        text: "Ship it now.",
        dispatchMode: "steer",
        context: buildCardReplyContext({
          itemId: "item-m1",
          kind: "action",
          actionIndex: 0,
          label: "Ship",
        }),
      }),
    );
  });

  it("submits tuned inputs via auto mode when idle and renders streaming skeleton", async () => {
    const card = makeCard({
      title: "Configure run",
      inputs: [
        { id: "mode", kind: "choice", label: "Mode", options: ["Fast", "Deep"], default: "Fast" },
        { id: "notify", kind: "toggle", label: "Notify", default: true },
        { id: "note", kind: "text", label: "Note", default: "" },
      ],
      submit: "Start",
    });

    act(() => {
      root.render(
        <AgentCard
          itemId="item-m2"
          card={card}
          lockedState={{ locked: false }}
          environmentId={envId}
          threadId={threadId}
          conversationThreadId={threadId}
          workspaceRoot="/repo"
          themeAppearance="dark"
          messageRunActive={false}
          canOperateMessage={true}
          onPressPreview={vi.fn()}
        />,
      );
    });

    const deepBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Deep"),
    )!;
    const startBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start"),
    )!;
    act(() => {
      deepBtn.click();
    });
    await act(async () => {
      startBtn.click();
    });

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Mode: Deep; Notify: On",
        dispatchMode: "auto",
      }),
    );

    act(() => {
      root.render(<AgentCardSkeleton title="Loading summary…" />);
    });
    expect(host.textContent).toContain("Loading summary…");
  });
});
