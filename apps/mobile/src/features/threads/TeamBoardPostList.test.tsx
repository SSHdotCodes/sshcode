// @vitest-environment jsdom
import { applyTeamBoardFrame } from "@t3tools/client-runtime/state/team-board";
import {
  NodeId,
  type ProviderDriverKind,
  type TeamBoardPost,
  type TeamBoardSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const rendered = vi.hoisted(() => ({ avatars: 0, rows: 0 }));

type Props = { readonly children?: ReactNode; readonly className?: string };
vi.mock("react-native", () => ({
  View: ({ children, className }: Props) =>
    createElement("div", { "data-class": className }, children),
  Pressable: ({ children, className }: Props) =>
    createElement("div", { "data-class": className }, children),
}));
vi.mock("@legendapp/list/react-native", () => ({
  // Renders every item; on a phone only the ones near the screen mount.
  LegendList: <T,>(props: {
    data: ReadonlyArray<T>;
    renderItem: (info: { item: T; index: number }) => ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) => {
    rendered.rows = props.data.length;
    return props.data.map((item, index) =>
      createElement(
        Fragment,
        { key: props.keyExtractor(item, index) },
        props.renderItem({ item, index }),
      ),
    );
  },
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: Props) => createElement("span", null, children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => {
    rendered.avatars++;
    return null;
  },
}));
vi.mock("../../lib/providerClients", () => ({ getProviderClient: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

import { TeamBoardPostList } from "./TeamBoardPostList";

const start = DateTime.makeUnsafe("2026-11-27T02:00:00Z");
const kite = NodeId.make("task-kite");
const drivers = new Map<string, ProviderDriverKind>([[kite, "codex" as ProviderDriverKind]]);
const onReply = () => {};

const post = (index: number, replyTo?: string): TeamBoardPost => ({
  id: `p${index}`,
  author: { name: "Kite", taskId: kite },
  kind: "finding",
  text: `Post ${index}`,
  at: DateTime.add(start, { seconds: index }),
  ...(replyTo === undefined ? {} : { replyTo }),
});
const snapshot = (posts: TeamBoardPost[]): TeamBoardSnapshot => ({
  active: true,
  postCount: posts.length,
  overlapCount: 0,
  presence: [],
  posts,
});
/** 300 posts by one subagent; every fifth replies to the post before it. */
const board = () =>
  snapshot(
    Array.from({ length: 300 }, (_, index) =>
      post(index, index % 5 === 4 ? `p${index - 1}` : undefined),
    ),
  );
/** One thread: a question and 299 replies down a chain. */
const thread = () =>
  snapshot(
    Array.from({ length: 300 }, (_, index) =>
      post(index, index === 0 ? undefined : `p${index - 1}`),
    ),
  );

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rendered.avatars = 0;
  rendered.rows = 0;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const show = (board: TeamBoardSnapshot) =>
  act(() =>
    root.render(
      <TeamBoardPostList
        posts={board.posts!}
        filter="all"
        taskId={null}
        emptyText="Nothing here yet."
        drivers={drivers}
        onReply={onReply}
      />,
    ),
  );

const textOf = (text: string) =>
  [...host.querySelectorAll("span")].find((node) => node.textContent === text)!;

/** The reply-line wrapper around a post's text, if it is a reply row. */
const replyLine = (text: string) => textOf(text).closest('[data-class*="ml-[51px]"]');
const delta = (from: TeamBoardSnapshot, posts: TeamBoardPost[]) => {
  const { posts: _posts, ...scalars } = from;
  return applyTeamBoardFrame(from, {
    ...scalars,
    postCount: from.postCount + 1,
    delta: true,
    posts,
  });
};

it("lists 300 posts one row each and re-renders only the rows a delta changed", () => {
  const first = board();
  show(first);
  expect(rendered.rows).toBe(300);
  expect(rendered.avatars).toBe(300);
  // A reply sits on its thread's indented line; a thread's first post does not.
  expect(replyLine("Post 4")).not.toBeNull();
  expect(replyLine("Post 3")).toBeNull();

  // A delta edits a post that has a reply: only its own row renders again.
  const next = delta(first, [{ ...first.posts![3]!, text: "Post 3, edited" }]);
  rendered.avatars = 0;
  show(next);
  expect(rendered.avatars).toBe(1);
  expect(textOf("Post 3, edited")).toBeDefined();
  // A new post adds one row and renders only itself.
  rendered.avatars = 0;
  show(delta(next, [post(300)]));
  expect(rendered.rows).toBe(301);
  expect(rendered.avatars).toBe(1);
});

it("virtualizes a 300-post thread by reply, keeping the reply line", () => {
  const first = thread();
  show(first);
  // One list row per reply, not one row holding the whole thread.
  expect(rendered.rows).toBe(300);
  expect(rendered.avatars).toBe(300);
  expect(replyLine("Post 0")).toBeNull();
  expect(replyLine("Post 1")).not.toBeNull();
  expect(replyLine("Post 299")).not.toBeNull();
  // Only the thread's last row draws the divider below the thread.
  const dividers = [...host.querySelectorAll('[data-class~="border-b"]')];
  expect(dividers).toHaveLength(1);
  expect(dividers[0]!.textContent).toContain("Post 299");

  // Editing one reply renders one row.
  const edited = delta(first, [{ ...first.posts![150]!, text: "Post 150, edited" }]);
  rendered.avatars = 0;
  show(edited);
  expect(rendered.avatars).toBe(1);
  // A new reply renders itself and the old last row, which hands it the divider.
  rendered.avatars = 0;
  show(delta(edited, [post(300, "p299")]));
  expect(rendered.rows).toBe(301);
  expect(rendered.avatars).toBe(2);
  const moved = [...host.querySelectorAll('[data-class~="border-b"]')];
  expect(moved.map((node) => node.textContent)).toEqual([expect.stringContaining("Post 300")]);
});
