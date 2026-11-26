// @vitest-environment jsdom
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-image", () => ({
  Image: (props: {
    onError: () => void;
    onLoad?: (event: { source: { width: number; height: number } }) => void;
  }) => (
    <img
      alt=""
      onError={props.onError}
      // Contact sheets decode much wider than the tile.
      onLoad={() => props.onLoad?.({ source: { width: 3000, height: 1000 } })}
    />
  ),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FlatList: <T,>(props: {
    data: ReadonlyArray<T>;
    keyExtractor: (item: T) => string;
    renderItem: (info: { item: T }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
  Pressable: (props: { children: ReactNode; onPress: () => void; style?: object }) => (
    <button onClick={props.onPress} style={props.style}>
      {props.children}
    </button>
  ),
  StyleSheet: { absoluteFill: {} },
  ActivityIndicator: () => <div data-testid="activity-indicator" />,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children: ReactNode }) => children,
  MediaActionFeedbackBadge: () => null,
}));
const assetUrlState = vi.hoisted(() => ({
  current: { _tag: "Success", url: "https://host.test/temporary" } as
    | { _tag: "Success"; url: string }
    | { _tag: "Loading" }
    | { _tag: "Failure" },
}));
vi.mock("../../state/assets", () => ({ useAssetUrlState: () => assetUrlState.current }));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));

import type { FilePreviewSource } from "../../components/FilePreviewModal.types";
import { ThreadImageStrip, type ThreadImageStripItem } from "./ThreadImageStrip";

it("keeps original hosted image bytes and filenames available on every swipeable page", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const items: ThreadImageStripItem[] = [0, 1].map((index) => {
    const resource = {
      _tag: "tool-output-image" as const,
      threadId: ThreadId.make("thread"),
      itemId: TurnItemId.make("tool"),
      index,
    };
    const environmentId = EnvironmentId.make("environment");
    return {
      key: String(index),
      name: `Screenshot ${index + 1}`,
      preview: { kind: "image", name: `Screenshot ${index + 1}`, environmentId, resource },
      actionsSource: {
        environmentId,
        resource,
        name: `tool-image-${index + 1}.webp`,
        mimeType: "image/webp",
      },
    };
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  let preview: FilePreviewSource | undefined;
  try {
    act(() =>
      root.render(
        <ThreadImageStrip
          items={items}
          height={120}
          ownGallery
          onPressPreview={(source) => {
            preview = source;
          }}
        />,
      ),
    );
    act(() => host.querySelector("button")!.click());
    expect(preview?.gallery).toHaveLength(2);
    expect(preview?.actionsSource).toEqual(
      "actionsSource" in items[0]! ? items[0].actionsSource : undefined,
    );
    const nextPage = preview?.gallery?.[1];
    expect(nextPage?.actionsSource).toEqual(
      "actionsSource" in items[1]! ? items[1].actionsSource : undefined,
    );
    expect(nextPage?.actionsSource && "resource" in nextPage.actionsSource).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it.each(["authorization", "decoding"])(
  "shows an unavailable tile when image %s fails",
  (failure) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settled = assetUrlState.current;
    if (failure === "authorization") assetUrlState.current = { _tag: "Failure" };
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          <ThreadImageStrip
            items={[
              {
                key: "guest",
                name: "Guest image",
                preview: {
                  kind: "image",
                  name: "Guest image",
                  environmentId: EnvironmentId.make("environment"),
                  resource: { _tag: "attachment", attachmentId: "image" },
                },
              },
            ]}
            height={180}
            ownGallery
            onPressPreview={() => {}}
          />,
        ),
      );
      if (failure === "decoding")
        act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
      expect(host.textContent).toContain("Image unavailable");
      expect(host.querySelector("button")).toBeNull();
    } finally {
      assetUrlState.current = settled;
      act(() => root.unmount());
    }
  },
);

it("shows the loading state while a tile's signed URL resolves", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const items: ThreadImageStripItem[] = [
    {
      key: "0",
      name: "Screenshot 1",
      preview: {
        kind: "image",
        name: "Screenshot 1",
        environmentId: EnvironmentId.make("environment"),
        resource: {
          _tag: "tool-output-image" as const,
          threadId: ThreadId.make("thread"),
          itemId: TurnItemId.make("tool"),
          index: 0,
        },
      },
    },
  ];
  const host = document.createElement("div");
  const root = createRoot(host);
  const settled = assetUrlState.current;
  assetUrlState.current = { _tag: "Loading" };
  try {
    act(() =>
      root.render(<ThreadImageStrip items={items} height={120} onPressPreview={() => {}} />),
    );
    expect(host.querySelector("[data-testid='activity-indicator']")).not.toBeNull();
  } finally {
    assetUrlState.current = settled;
    act(() => root.unmount());
  }
});

it("keeps every tile one width while pictures arrive and decode", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const tile = (index: number): ThreadImageStripItem => ({
    key: String(index),
    name: `Sheet ${index + 1}`,
    preview: {
      kind: "image",
      name: `Sheet ${index + 1}`,
      environmentId: EnvironmentId.make("environment"),
      resource: {
        _tag: "tool-output-image",
        threadId: ThreadId.make("thread"),
        itemId: TurnItemId.make(`tool-${index}`),
        index: 0,
      },
    },
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  const widths = () => [...host.querySelectorAll("button")].map((button) => button.style.width);
  const render = (items: ThreadImageStripItem[]) =>
    act(() =>
      root.render(<ThreadImageStrip items={items} height={120} onPressPreview={() => {}} />),
    );
  try {
    render([tile(0), { key: "pending", pending: true }]);
    expect(widths()).toEqual(["160px"]);
    act(() => host.querySelectorAll("img").forEach((img) => img.dispatchEvent(new Event("load"))));
    render([tile(0), tile(1), tile(2)]);
    act(() => host.querySelectorAll("img").forEach((img) => img.dispatchEvent(new Event("load"))));
    expect(widths()).toEqual(["160px", "160px", "160px"]);
  } finally {
    act(() => root.unmount());
  }
});
