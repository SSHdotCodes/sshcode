import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ICloudFolderNotice } from "./ICloudFolderNotice";
import { Button } from "../ui/button";

let renderer: ReactTestRenderer | undefined;
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("remembers dismissal for one chat across remounts and keeps other chats visible", async () => {
  await act(async () => {
    renderer = create(<ICloudFolderNotice chatKey="mac:chat-a" />);
  });
  expect(renderer!.root.findAllByType(Button)).toHaveLength(1);
  await act(async () => {
    renderer!.root.findByType(Button).props.onClick();
  });
  expect(renderer!.toJSON()).toBeNull();
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(<ICloudFolderNotice chatKey="mac:chat-a" />);
  });
  expect(renderer!.toJSON()).toBeNull();
  await act(async () =>
    renderer!.update(<ICloudFolderNotice key="mac:chat-b" chatKey="mac:chat-b" />),
  );
  expect(renderer!.root.findAllByType(Button)).toHaveLength(1);
});

it("can be dismissed when browser storage is unavailable", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("disabled");
    },
    setItem: () => {
      throw new Error("disabled");
    },
  });
  await act(async () => {
    renderer = create(<ICloudFolderNotice chatKey="mac:chat-a" />);
  });
  await act(async () => {
    renderer!.root.findByType(Button).props.onClick();
  });
  expect(renderer!.toJSON()).toBeNull();
});
