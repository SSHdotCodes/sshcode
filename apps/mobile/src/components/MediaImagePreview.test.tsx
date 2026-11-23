// @vitest-environment jsdom
import { act, createElement, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { MediaActionsSource } from "../lib/mediaActionsSource";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

const shared = vi.hoisted(() => vi.fn());
vi.mock("../state/mediaActions", () => ({
  useMediaActions: (source: MediaActionsSource) => ({
    actions: [{ id: "save", run: () => shared(source) }],
  }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("./AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./MediaActionsMenu", () => ({ MediaActionsMenu: () => null }));
vi.mock("./MediaSourceCaption", () => ({ MediaSourceCaption: () => null }));
vi.mock("./MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("./ImageMarkupEditor", () => ({
  ImageMarkupEditor: ({ onCancel }: { onCancel: () => void }) => (
    <button onClick={onCancel}>Cancel markup</button>
  ),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StatusBar: () => null,
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Image: ({ source }: { source: { uri: string } }) => <div data-page-uri={source.uri} />,
  Pressable: ({
    onPress,
    accessibilityLabel,
    children,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    children: ReactNode;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: <T,>(props: {
    data: T[];
    initialScrollIndex: number;
    renderItem: (info: { item: T; index: number }) => ReactNode;
    onMomentumScrollEnd: (event: { nativeEvent: { contentOffset: { x: number } } }) => void;
  }) => {
    const [page, setPage] = useState(props.initialScrollIndex);
    return (
      <div>
        <button
          onClick={() => {
            setPage(1);
            props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 } } });
          }}
        >
          Next image
        </button>
        {props.renderItem({ item: props.data[page]!, index: page })}
      </div>
    );
  },
}));
vi.mock("react-native-image-viewing", () => ({
  default: (props: {
    images: { uri: string }[];
    imageIndex: number;
    onImageIndexChange: (index: number) => void;
    HeaderComponent: ComponentType<{ imageIndex: number }>;
    FooterComponent: ComponentType;
  }) => {
    const [page, setPage] = useState(props.imageIndex);
    return (
      <div>
        <div data-page-uri={props.images[page]?.uri} />
        <button
          onClick={() => {
            setPage(1);
            props.onImageIndexChange(1);
          }}
        >
          Next image
        </button>
        {createElement(props.HeaderComponent, { imageIndex: page })}
        {createElement(props.FooterComponent)}
      </div>
    );
  },
}));
import { MediaImagePreview } from "./MediaImagePreview";

it.each([false, true])(
  "returns from markup to the displayed image and shares that same image (mixed pager: %s)",
  (mixed) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    shared.mockClear();
    const host = document.createElement("div");
    const root = createRoot(host);
    const gallery: NonNullable<ResolvedFilePreviewSource["gallery"]> = ["one", "two"].map(
      (name) => ({
        kind: "image",
        name,
        uri: `file:///${name}.png`,
        ...(mixed ? { occurrenceId: name } : {}),
      }),
    );
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find(
        (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
      )!;
    try {
      act(() =>
        root.render(
          <MediaImagePreview
            source={{ ...gallery[0]!, gallery, galleryIndex: 0 }}
            onRequestClose={() => {}}
          />,
        ),
      );
      act(() => button("Next image").click());
      act(() => button("Markup").click());
      act(() => button("Cancel markup").click());
      expect(host.querySelector("[data-page-uri]")?.getAttribute("data-page-uri")).toBe(
        "file:///two.png",
      );
      act(() => button("Share").click());
      expect(shared).toHaveBeenCalledWith(
        expect.objectContaining({ uri: "file:///two.png", name: "two" }),
      );
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
