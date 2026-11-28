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
  Pressable: ({
    children,
    className,
    onPress,
    accessibilityLabel,
  }: Props & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement(
      "div",
      { "data-class": className, onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
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

import { TeamBoardPeople, TeamBoardPostList, teamBoardChipHitSlop } from "./TeamBoardPostList";

const start = DateTime.makeUnsafe("2026-11-27T02:00:00Z");
const kite = NodeId.make("task-kite");
const drivers = new Map([
  [
    kite as string,
    {
      title: "Fix the parser",
      driver: "codex" as ProviderDriverKind,
      providerInstanceId: null,
      model: "gpt-5",
      childThreadId: "child-kite",
    },
  ],
]);
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

it("says who sent each post and opens that subagent's chat on tap", () => {
  const opened: string[] = [];
  act(() =>
    root.render(
      <TeamBoardPeople value={{ providers: [], onOpen: (threadId) => opened.push(threadId) }}>
        <TeamBoardPostList
          posts={[post(1)]}
          filter="all"
          taskId={null}
          emptyText="Nothing here yet."
          drivers={drivers}
          onReply={onReply}
        />
      </TeamBoardPeople>,
    ),
  );
  // The task title the chat's subagent row shows, then the model's short name.
  expect(textOf("Fix the parser")).toBeDefined();
  expect(textOf("GPT-5")).toBeDefined();
  const row = host.querySelector('[aria-label="Open Fix the parser"]') as HTMLElement;
  act(() => row.click());
  expect(opened).toEqual(["child-kite"]);
});

it("names whom a post is for and collapses a thread to its reply count", () => {
  const question: TeamBoardPost = {
    id: "q",
    author: { name: "Kite", taskId: kite },
    kind: "question",
    text: "Can you check the parser?",
    at: start,
    to: "you",
  };
  const replies = [1, 2].map((index): TeamBoardPost => ({
    id: `r${index}`,
    author: { name: "Sam", user: true },
    kind: "message",
    text: `Answer ${index}`,
    at: DateTime.add(start, { seconds: index }),
    replyTo: "q",
  }));
  act(() =>
    root.render(
      <TeamBoardPostList
        posts={[question, ...replies]}
        filter="all"
        taskId={null}
        emptyText="Nothing here yet."
        drivers={drivers}
        onReply={onReply}
      />,
    ),
  );
  expect(textOf("→")).toBeDefined();
  expect(textOf("You")).toBeDefined();
  expect(textOf("Answer 2")).toBeDefined();
  act(() => (textOf("Hide replies").parentElement as HTMLElement).click());
  expect(textOf("2 replies")).toBeDefined();
  expect([...host.querySelectorAll("span")].some((node) => node.textContent === "Answer 2")).toBe(
    false,
  );
});

it("chip touch rule: every chip with room around it takes taps 44 pt wide, and neighbours never overlap", () => {
  const gap = 6;
  for (const count of [1, 2, 5, 9])
    for (const widths of [
      Array.from({ length: count }, () => 36),
      Array.from({ length: count }, (_, index) => 30 + index * 9),
      Array.from({ length: count }, () => 120),
    ]) {
      const slops = widths.map((width, index) => teamBoardChipHitSlop(width, index, count, 6));
      for (const [index, slop] of slops.entries()) {
        expect(slop.top).toBe(6);
        expect(slop.bottom).toBe(6);
        // A chip between two others can grow only into half of each gap.
        const room = (index === 0 ? 20 : gap / 2) + (index === count - 1 ? 20 : gap / 2);
        expect(widths[index]! + slop.left + slop.right).toBeGreaterThanOrEqual(
          Math.min(44, widths[index]! + room),
        );
        const next = slops[index + 1];
        if (next !== undefined) expect(slop.right + next.left).toBeLessThanOrEqual(gap);
      }
    }
  // The "All" filter, 36 pt wide and first, reaches 44 pt.
  const all = teamBoardChipHitSlop(36, 0, 5, 6);
  expect(36 + all.left + all.right).toBe(44);
});
