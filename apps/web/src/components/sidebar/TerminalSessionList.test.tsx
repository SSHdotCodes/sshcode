// @vitest-environment jsdom
import { act, type ComponentProps, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import type { ClaudeRcState } from "@t3tools/client-runtime/claude-rc";
import { EnvironmentId, type ClaudeRcSession } from "@t3tools/contracts";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { reduceClaudeRcEvent } from "@t3tools/client-runtime/claude-rc";

const queried = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  watchError: null as string | null,
  uiMode: "default",
  sessions: 0,
  watch: 0,
  commands: [] as Array<{ environmentId: string; input: { action: string } }>,
  sessionsData: null as ClaudeRcSession[] | null,
  sessionsError: null as string | null,
  watchData: null as ClaudeRcState | null,
  allowed: true,
  commandResult: { _tag: "Success" as const, value: undefined } as
    | { _tag: "Success"; value: undefined }
    | { _tag: "Failure"; cause: Cause.Cause<unknown> },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "configs"
      ? new Map([["mac", { environment: { capabilities: { claudeRemoteControl: true } } }]])
      : queried.allowed,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    environmentId: "mac",
    label: "Fixture Mac",
    connection: { phase: "connected" },
  }),
}));
vi.mock("../../hooks/useTheme", () => ({ useUiMode: () => [queried.uiMode] }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ setOpenMobile: vi.fn() }),
  SidebarInset: ({ children }: { children: import("react").ReactNode }) => <main>{children}</main>,
  SidebarTrigger: () => <button aria-label="Toggle sidebar" />,
}));
vi.mock("../../state/claudeRc", () => ({
  claudeRcEnvironment: {
    sessions: (input: unknown) => ({ kind: "sessions" as const, input }),
    watch: (input: unknown) => ({ kind: "watch" as const, input }),
    command: { permissionAtom: () => ({ kind: "permission" as const }) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: "sessions" | "watch" }) => {
    if (atom.kind === "sessions") {
      queried.sessions += 1;
      return { data: queried.sessionsData, error: queried.sessionsError, refresh: vi.fn() };
    }
    queried.watch += 1;
    const data = useSyncExternalStore(
      (listener) => {
        queried.listeners.add(listener);
        return () => {
          queried.listeners.delete(listener);
        };
      },
      () => queried.watchData,
    );
    return { data, error: queried.watchError, refresh: vi.fn() };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: { environmentId: string; input: { action: string } }) => {
    queried.commands.push(input);
    return queried.commandResult;
  },
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <p>{text}</p>,
}));

import { TerminalSessionList } from "./TerminalSessionList";
import { TerminalSessionRouteView } from "./TerminalSessionRouteView";

const mac = EnvironmentId.make("mac");
const session: ClaudeRcSession = {
  id: "cse_fixture",
  title: "Review the login",
  updatedAt: "2026-10-27T12:00:00.000Z",
  working: false,
};
const transcript = {
  phase: "connected" as const,
  working: false,
  message: null,
  items: [
    { id: "user", role: "user" as const, text: "Check the login" },
    { id: "tool", role: "tool" as const, text: "read file" },
    { id: "assistant", role: "assistant" as const, text: "Hello from the CLI" },
  ],
  permissions: [{ requestId: "req_1", toolName: "Bash", description: "Run the tests" }],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queried.sessions = 0;
  queried.watch = 0;
  queried.commands = [];
  queried.sessionsData = null;
  queried.sessionsError = null;
  queried.watchData = null;
  queried.allowed = true;
  queried.uiMode = "default";
  queried.watchError = null;
  queried.commandResult = { _tag: "Success", value: undefined };
  vi.unstubAllGlobals();
});

async function render(props: Partial<ComponentProps<typeof TerminalSessionList>> = {}, path = "/") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.scrollTo = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TerminalSessionList
          environmentId={mac}
          label="Fixture Mac"
          query=""
          connected
          connecting={false}
          configLoaded
          claudeRemoteControl
          {...props}
        />
        <Outlet />
      </>
    ),
  });
  const terminalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/terminal/$environmentId/$sessionId",
    component: () => {
      const params = useParams({ strict: false });
      return (
        <TerminalSessionRouteView
          environmentId={EnvironmentId.make(params.environmentId!)}
          sessionId={params.sessionId!}
        />
      );
    },
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const terminalLanding = createRoute({
    getParentRoute: () => rootRoute,
    path: "/terminal",
    component: () => <p>Choose a terminal session.</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, terminalLanding, terminalRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

async function stream(event: Parameters<typeof reduceClaudeRcEvent>[1]) {
  await act(async () => {
    queried.watchData = reduceClaudeRcEvent(queried.watchData!, event);
    for (const notify of queried.listeners) notify();
  });
}

function button(name: string) {
  const buttons = [...container!.querySelectorAll("button")];
  const match =
    buttons.find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name || candidate.textContent === name,
    ) ?? buttons.find((candidate) => candidate.textContent?.includes(name));
  if (!match) {
    throw new Error(
      `Missing button ${name}: ${buttons.map((item) => item.textContent).join(" | ")}`,
    );
  }
  return match;
}

async function typeDraft(value: string) {
  const textarea = container!.querySelector("textarea");
  if (!textarea) throw new Error("Missing composer");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("does not ask an older host for sessions", async () => {
  await render({ claudeRemoteControl: undefined });
  expect(container!.textContent).toContain("Update SSHCode on this machine");
  expect(queried.sessions).toBe(0);
  expect(queried.watch).toBe(0);
});

it("waits for the host config before asking for sessions", async () => {
  await render({ configLoaded: false, claudeRemoteControl: undefined });
  expect(container!.textContent).toContain("Looking for sessions…");
  expect(queried.sessions).toBe(0);
});

it("navigates to a full chat, renders history and streamed text, and controls the CLI", async () => {
  queried.sessionsData = [{ ...session, working: true }];
  queried.watchData = { ...transcript, working: true };
  const router = await render();
  expect(container!.textContent).toContain("Terminal session");
  expect(container!.textContent).toContain("Review the login");
  await act(async () => container!.querySelector<HTMLAnchorElement>("a")!.click());
  expect(router.state.location.pathname).toBe("/terminal/mac/cse_fixture");
  expect(container!.querySelector('[aria-current="page"]')).not.toBeNull();
  expect(container!.querySelector('[role="dialog"]')).toBeNull();
  expect(container!.querySelector("main")?.textContent).toContain("Hello from the CLI");
  expect(container!.querySelector("pre")).toBeNull();
  await act(async () => button("read file").click());
  expect(container!.querySelector("pre")?.textContent).toBe("read file");
  await stream({ type: "textDelta", id: "assistant", text: " live" });
  expect(container!.textContent).toContain("Hello from the CLI live");
  expect(queried.watch).toBeGreaterThan(0);
  await act(async () => button("Stop").click());
  await act(async () => button("Allow").click());
  expect(queried.commands.map((command) => command.input)).toEqual([
    { action: "interrupt", sessionId: session.id },
    { action: "permission", sessionId: session.id, requestId: "req_1", allow: true },
  ]);
});

it("keeps the draft when sending fails and refuses an oversized message", async () => {
  queried.sessionsData = [session];
  queried.watchData = transcript;
  queried.commandResult = { _tag: "Failure", cause: Cause.fail(new Error("offline")) };
  await render();
  await act(async () => container!.querySelector<HTMLAnchorElement>("a")!.click());
  await typeDraft("keep me");
  await act(async () => button("Send").click());
  expect(container!.querySelector("textarea")?.value).toBe("keep me");
  expect(container!.textContent).toContain("offline");
  queried.commands = [];
  await typeDraft("x".repeat(100_001));
  await act(async () => button("Send").click());
  expect(queried.commands).toEqual([]);
  expect(container!.textContent).toContain("That message is too long.");
  expect(container!.querySelector("textarea")?.value).toBe("x".repeat(100_001));
});

it("reloads directly into the chat, sends with Enter, and offers a way back on disconnect", async () => {
  queried.sessionsData = [session];
  queried.watchData = transcript;
  const router = await render({}, "/terminal/mac/cse_fixture");
  expect(container!.querySelector("main")?.textContent).toContain("Fixture Mac");
  await typeDraft("hello");
  await act(async () =>
    container!
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(queried.commands.at(-1)?.input).toEqual({
    action: "send",
    sessionId: session.id,
    text: "hello",
  });
  expect(container!.querySelector("textarea")?.value).toBe("");
  await stream({
    type: "item",
    item: { id: "notice", role: "notice", text: "Answer this in the terminal" },
  });
  expect(container!.textContent).toContain("Answer this in the terminal");
  await act(async () => button("Deny").click());
  expect(queried.commands.at(-1)?.input).toEqual({
    action: "permission",
    sessionId: session.id,
    requestId: "req_1",
    allow: false,
  });
  await stream({ type: "status", phase: "disconnected", working: false });
  expect(container!.textContent).toContain("Disconnected.");
  expect(button("Send").disabled).toBe(true);
  await act(async () => button("Back to Terminal sessions").click());
  expect(router.state.location.pathname).toBe("/terminal");
  expect(container!.textContent).toContain("Choose a terminal session.");
  expect(container!.querySelector("textarea")).toBeNull();
});

it("keeps terminal-only controls in both layouts", async () => {
  queried.sessionsData = [session];
  queried.watchData = transcript;
  queried.uiMode = "discord";
  await render({}, "/terminal/mac/cse_fixture");
  const main = container!.querySelector("main")!;
  expect(main.querySelector("[data-dc-message]")).not.toBeNull();
  expect(main.querySelector("[data-user-message-bubble]")).not.toBeNull();
  expect(main.querySelector('[data-slot="composer-shell"]')).not.toBeNull();
  expect(
    [...main.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["Toggle sidebar", "read file", "Allow", "Deny", "Send"]);
  expect(main.querySelector('input[type="file"], select, [role="combobox"]')).toBeNull();
});
