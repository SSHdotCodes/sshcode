// @vitest-environment jsdom
import type { EnvironmentId, XPostPreview } from "@t3tools/contracts";
import { act, createContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ read: vi.fn(), width: 300 }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    style,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    style?: { width?: number };
  }) => (
    <button aria-label={accessibilityLabel} data-width={style?.width} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("expo-image", () => ({
  Image: ({ source }: { source: { uri: string } }) => <img src={source.uri} alt="" />,
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => <i data-symbol="play" /> }));
vi.mock("../../state/server", () => ({ serverEnvironment: { getXPostPreview: "read" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.read }));
vi.mock("./ThreadMarkdownImage", () => ({
  MarkdownImageAvailableWidthContext: createContext(0),
}));

import { MarkdownImageAvailableWidthContext } from "./ThreadMarkdownImage";
import { XPostCards } from "./XPostCards";

const environmentId = "env" as EnvironmentId;
const card = (id: string, patch: Partial<XPostPreview> = {}): XPostPreview => ({
  url: `https://x.com/someone/status/${id}`,
  authorName: "Some One",
  authorHandle: "someone",
  text: `post ${id}`,
  createdAt: "2026-11-09T12:00:00.000Z",
  image: null,
  ...patch,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.read.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const draw = (text: string, onOpen: ((url: string) => void) | undefined, width = 300) =>
  act(async () => {
    root.render(
      <MarkdownImageAvailableWidthContext value={width}>
        <XPostCards text={text} environmentId={environmentId} onOpen={onOpen} />
      </MarkdownImageAvailableWidthContext>,
    );
  });

it("draws a card per linked post, fits the bubble and opens the post", async () => {
  harness.read.mockImplementation(async ({ input }: { input: { url: string } }) => ({
    _tag: "Success",
    value: input.url.endsWith("/7001")
      ? card("7001", {
          image: { url: "https://pbs.twimg.com/media/a.jpg?name=small", video: true },
        })
      : card("7002"),
  }));
  const onOpen = vi.fn();
  await draw(
    "https://x.com/someone/status/7001?s=20 and https://x.com/someone/status/7002",
    onOpen,
  );
  const cards = [...host.querySelectorAll("button")];
  expect(cards).toHaveLength(2);
  expect(cards[0]!.getAttribute("aria-label")).toBe("Post by Some One on X");
  expect(cards[0]!.dataset.width).toBe("300");
  expect(cards[0]!.textContent).toContain("@someone");
  expect(cards[0]!.textContent).toContain("post 7001");
  expect(cards[0]!.querySelector("img")?.getAttribute("src")).toBe(
    "https://pbs.twimg.com/media/a.jpg?name=small",
  );
  expect(cards[0]!.querySelector("[data-symbol]")).not.toBeNull();
  expect(cards[1]!.querySelector("img")).toBeNull();
  act(() => cards[1]!.click());
  expect(onOpen).toHaveBeenCalledWith("https://x.com/someone/status/7002");
  expect(harness.read).toHaveBeenCalledTimes(2);

  // A wide screen does not stretch the card.
  await draw("https://x.com/someone/status/7001", onOpen, 900);
  expect(host.querySelector("button")!.dataset.width).toBe("360");
});

it("takes no room for plain messages or posts X will not show", async () => {
  await draw("no links here, only https://x.com/someone", vi.fn());
  expect(host.innerHTML).toBe("");
  expect(harness.read).not.toHaveBeenCalled();

  harness.read.mockResolvedValueOnce({ _tag: "Success", value: null });
  await draw("https://x.com/someone/status/7003", vi.fn());
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toBe("");
});
