import type { ClientSettings } from "@t3tools/contracts/settings";
import {
  type DesktopNotification,
  type DesktopNotificationResponse,
  EnvironmentId,
  type OrchestrationV2UserInputQuestion,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  soundEvents: "needs-you" as ClientSettings["notificationSoundEvents"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  inputRequestId: "request-1",
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  helper: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  delegatedChild: null as "running" | "approval" | null,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  loadProjection: vi.fn(),
  waitForConnection: vi.fn(),
  respondToApproval: vi.fn(),
  respondToUserInput: vi.fn(),
  showNative: vi.fn(async (_notification: DesktopNotification) => true),
  closeNative: vi.fn(async (_id: string) => {}),
  focusNative: vi.fn(async () => {}),
  nativeListeners: new Set<(response: DesktopNotificationResponse) => void>(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: state.helper ? "models:saved" : "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: state.inputRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// A delegated child changes while its parent's shell object stays the same.
let stableParent: ReturnType<typeof mockThreadShell> | null = null;
function mockThreads() {
  if (state.delegatedChild === null) return [mockThreadShell()];
  stableParent ??= mockThreadShell();
  const child = {
    ...mockThreadShell(),
    id: "child-1",
    title: "Review the login form",
    creationSource: "mcp",
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest:
      state.delegatedChild === "approval"
        ? { id: "request-2", kind: "command", createdAt: SHELL_NOW }
        : null,
  };
  return [stableParent, child];
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: mockThreads() }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<
        ClientSettings,
        "notificationMode" | "notificationSoundEvents" | "inAppNotificationsEnabled"
      >,
    ) => unknown,
  ) =>
    select({
      notificationMode: state.mode,
      notificationSoundEvents: state.soundEvents,
      inAppNotificationsEnabled: state.inApp,
    }),
  getClientSettings: () => ({
    notificationMode: state.mode,
    notificationSoundEvents: state.soundEvents,
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../state/notificationRequests", () => ({ notificationThreadProjection: "load" }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    waitForSendConnection: "wait",
    respondToApproval: "approval",
    respondToUserInput: "input",
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "wait" ? state.waitForConnection : state.loadProjection,
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) =>
    command === "approval" ? state.respondToApproval : state.respondToUserInput,
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { useSplitChatStore } from "../splitChatStore";
import {
  ThreadNotificationCoordinator,
  threadNotificationTitle,
} from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  useSplitChatStore.setState({ split: null });
  Object.assign(state, {
    mode: "off",
    soundEvents: "needs-you",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    inputRequestId: "request-1",
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    helper: false,
    subagent: false,
    background: [],
    delegatedChild: null,
  });
  stableParent = null;
  state.nativeListeners.clear();
  state.loadProjection.mockReset();
  state.waitForConnection.mockResolvedValue({ _tag: "Success" });
  state.respondToApproval.mockResolvedValue({ _tag: "Success" });
  state.respondToUserInput.mockResolvedValue({ _tag: "Success" });
  state.showNative.mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps Models completions and questions silent with focus=%s",
    async (focused) => {
      state.helper = true;
      state.focused = focused;
      state.mode = "notifications-and-sound";
      await render();
      await complete();
      state.input = true;
      await render();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
      expect(state.showNative).not.toHaveBeenCalled();
    },
  );

  it("alerts on the parent when its delegated subagent asks for approval", async () => {
    state.mode = "notifications-and-sound";
    state.delegatedChild = "running";
    await render();
    state.delegatedChild = "approval";
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Approval needed", description: "Fix the login form" }),
    );
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Finished");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Question"],
    ["approval", "Approval needed"],
    ["sessionError", "Failed"],
    ["turnError", "Failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Finished" }));
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps a finished turn silent unless finished turns are asked for too", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).not.toHaveBeenCalled();
    // The toast still shows: only the sound is limited to chats that need the user.
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    state.soundEvents = "all";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Finished", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("names questions, key requests and finished chats", () => {
    expect(threadNotificationTitle("completion", "ready", undefined)).toBe("Finished");
    expect(threadNotificationTitle("input", "input", "runtime-request:ask-user:t:k")).toBe(
      "Question",
    );
    expect(threadNotificationTitle("input", "input", "turn-item:secret-request:api-key:t:k")).toBe(
      "API key needed",
    );
    expect(threadNotificationTitle("input", "input", "turn-item:secret-request:t:k")).toBe(
      "Secret needed",
    );
    expect(threadNotificationTitle("input", "approval", "request-1")).toBe("Approval needed");
  });

  it("alerts again for a second request in the same run", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    state.input = true;
    state.inputRequestId = "runtime-request:ask-user:thread-1:first";
    await render();
    state.inputRequestId = "turn-item:secret-request:api-key:thread-1:second";
    await render();
    expect(state.notification).toHaveBeenCalledTimes(2);
    expect(state.notification).toHaveBeenNthCalledWith(1, "Question", expect.anything());
    expect(state.notification).toHaveBeenNthCalledWith(2, "API key needed", expect.anything());
  });
});

const question: OrchestrationV2UserInputQuestion = {
  id: "question-1",
  header: "Approach",
  question: "Which approach should I use?",
  options: [
    { label: "Second choice", description: "Second choice", value: " second-value " },
    { label: "First choice (Recommended)", description: "First choice", value: "first-value" },
    { label: "Third choice", description: "Third choice" },
  ],
};

function projection({
  kind = "user_input",
  questions = [question],
  status = "pending",
  responseCapability = "live",
  requestId = "request-1",
  approvalOptions,
}: {
  kind?: "user_input" | "command";
  questions?: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  status?: "pending" | "resolved";
  responseCapability?: "live" | "not_resumable" | "message";
  requestId?: string;
  approvalOptions?: ReadonlyArray<{ label: string; decision: "accept" | "decline" }>;
} = {}) {
  return {
    runtimeRequests: [
      {
        id: RuntimeRequestId.make(requestId),
        kind,
        status,
        createdAt: SHELL_NOW,
        responseCapability: { type: responseCapability },
      },
    ],
    turnItems: [
      {
        type: kind === "user_input" ? "user_input_request" : "approval_request",
        requestId: RuntimeRequestId.make(requestId),
        questions,
        prompt: "Allow running the command?",
        ...(approvalOptions === undefined ? {} : { options: approvalOptions }),
      },
    ],
  };
}

function enableNative(platform = "darwin") {
  state.mode = "notifications-and-sound";
  state.focused = false;
  Object.assign(window, {
    desktopBridge: {
      getClientPlatform: () => platform,
      showNotification: state.showNative,
      closeNotification: state.closeNative,
      focusNotificationWindow: state.focusNative,
      onNotificationResponse: (listener: (response: DesktopNotificationResponse) => void) => {
        state.nativeListeners.add(listener);
        return () => state.nativeListeners.delete(listener);
      },
    },
  });
  state.loadProjection.mockResolvedValue({ _tag: "Success", value: projection() });
}

async function nativeResponse(
  response:
    | Omit<Extract<DesktopNotificationResponse, { type: "action" }>, "id">
    | Omit<Extract<DesktopNotificationResponse, { type: "reply" }>, "id">
    | { type: "click" },
  index = 0,
) {
  const id = state.showNative.mock.calls[index]![0].id;
  await act(async () => {
    for (const listener of state.nativeListeners) listener({ id, ...response });
  });
}

describe("mac notification responses", () => {
  it.each([
    [0, "first-value"],
    [1, " second-value "],
    [2, "Third choice"],
  ])("answers option %s using its card value", async (actionIndex, answer) => {
    enableNative();
    state.inputRequestId = "runtime-request:ask-user:thread-1:question";
    state.loadProjection.mockResolvedValue({
      _tag: "Success",
      value: projection({ requestId: state.inputRequestId }),
    });
    await render();
    state.input = true;
    await render();
    expect(state.showNative).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Question",
        body: question.question,
        tag: "env-1:thread-1",
        actions: ["First choice (Recommended)", "Second choice", "Third choice"],
        hasReply: true,
      }),
    );
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    await nativeResponse({ type: "action", actionIndex: Number(actionIndex) });
    expect(state.waitForConnection).toHaveBeenCalledOnce();
    expect(state.loadProjection).toHaveBeenCalledTimes(2);
    expect(state.loadProjection).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { threadId: "thread-1" },
    });
    expect(state.respondToUserInput).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-1",
      input: {
        threadId: "thread-1",
        requestId: state.inputRequestId,
        resendAfterSocketLoss: true,
        answers: { "question-1": answer },
      },
    });
  });

  it.each([undefined, "seeded text"])(
    "normalizes a custom reply like the card with initial text %s",
    async (initialAnswer) => {
      enableNative();
      state.loadProjection.mockResolvedValue({
        _tag: "Success",
        value: projection({ questions: [{ ...question, initialAnswer }] }),
      });
      await render();
      state.input = true;
      await render();
      await nativeResponse({ type: "reply", reply: "  my answer  " });
      expect(state.respondToUserInput).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            threadId: "thread-1",
            requestId: "request-1",
            resendAfterSocketLoss: true,
            answers: { "question-1": initialAnswer === undefined ? "my answer" : "  my answer  " },
          },
        }),
      );
    },
  );

  it.each(["multiple", "multi-select", "no-custom", "not-resumable", "free-text", "message"])(
    "respects the card's %s question capabilities",
    async (condition) => {
      enableNative();
      const questions =
        condition === "multiple"
          ? [question, { ...question, id: "question-2" }]
          : [
              {
                ...question,
                ...(condition === "multi-select" ? { multiSelect: true } : {}),
                ...(condition === "no-custom" ? { allowCustomAnswer: false } : {}),
                ...(condition === "free-text" ? { options: [] } : {}),
              },
            ];
      state.loadProjection.mockResolvedValue({
        _tag: "Success",
        value: projection({
          questions,
          responseCapability:
            condition === "not-resumable"
              ? "not_resumable"
              : condition === "message"
                ? "message"
                : "live",
        }),
      });
      await render();
      state.input = true;
      await render();
      const notification = state.showNative.mock.calls[0]![0];
      expect(notification.hasReply).toBe(["free-text", "message"].includes(condition));
      expect(notification.actions).toHaveLength(
        ["no-custom", "message"].includes(condition) ? 3 : 0,
      );
      if (condition === "multiple" || condition === "multi-select") {
        await nativeResponse({ type: "click" });
        expect(state.navigate).toHaveBeenCalled();
        expect(state.respondToUserInput).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "resolved",
    "different-request",
    "unavailable",
    "changed-question",
    "revoked-custom",
    "empty-reply",
  ])("opens the chat without answering when %s", async (condition) => {
    enableNative();
    await render();
    state.input = true;
    await render();
    if (condition === "unavailable") state.loadProjection.mockResolvedValue({ _tag: "Failure" });
    else
      state.loadProjection.mockResolvedValue({
        _tag: "Success",
        value: projection({
          ...(condition === "resolved" ? { status: "resolved" } : {}),
          ...(condition === "different-request" ? { requestId: "new-request" } : {}),
          ...(condition === "changed-question"
            ? { questions: [{ ...question, id: "new-question" }] }
            : {}),
          ...(condition === "revoked-custom"
            ? { questions: [{ ...question, allowCustomAnswer: false }] }
            : {}),
        }),
      });
    await nativeResponse({
      type: "reply",
      reply: condition === "empty-reply" ? "   " : "my answer",
    });
    expect(state.respondToUserInput).not.toHaveBeenCalled();
    expect(state.respondToApproval).not.toHaveBeenCalled();
    expect(state.focusNative).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it.each(["accept", "decline"])("sends the approval card's %s decision", async (decision) => {
    enableNative();
    state.loadProjection.mockResolvedValue({
      _tag: "Success",
      value: projection({ kind: "command" }),
    });
    await render();
    state.approval = true;
    await render();
    expect(state.showNative).toHaveBeenCalledWith(
      expect.objectContaining({ actions: ["Approve", "Decline"], hasReply: false }),
    );
    await nativeResponse({ type: "action", actionIndex: decision === "accept" ? 0 : 1 });
    expect(state.respondToApproval).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-1",
      input: {
        threadId: "thread-1",
        requestId: "request-1",
        decision,
      },
    });
    expect(state.respondToUserInput).not.toHaveBeenCalled();
  });

  it("does not offer approval decisions the provider omitted", async () => {
    enableNative();
    state.loadProjection.mockResolvedValue({
      _tag: "Success",
      value: projection({
        kind: "command",
        approvalOptions: [{ decision: "decline", label: "Decline" }],
      }),
    });
    await render();
    state.approval = true;
    await render();
    expect(state.showNative.mock.calls[0]![0].actions).toEqual(["Decline"]);
    state.loadProjection.mockResolvedValue({
      _tag: "Success",
      value: projection({ kind: "command", status: "resolved" }),
    });
    await nativeResponse({ type: "action", actionIndex: 0 });
    expect(state.respondToApproval).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalled();
  });

  it.each(["failure", "throw"])(
    "falls back to a plain native alert on a details %s",
    async (failure) => {
      enableNative();
      if (failure === "throw") state.loadProjection.mockRejectedValue(new Error("Offline"));
      else state.loadProjection.mockResolvedValue({ _tag: "Failure" });
      await render();
      state.input = true;
      await render();
      expect(state.showNative).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Fix the login form", actions: [], hasReply: false }),
      );
      await nativeResponse({ type: "click" });
      expect(state.navigate).toHaveBeenCalled();
    },
  );

  it.each(["key", "secret", "completedAt", "sessionError", "limited"])(
    "keeps %s alerts click-only",
    async (condition) => {
      enableNative();
      await render();
      if (condition === "key" || condition === "secret") {
        state.input = true;
        state.inputRequestId =
          condition === "key"
            ? "turn-item:secret-request:api-key:one"
            : "turn-item:secret-request:one";
      } else if (condition === "completedAt") state.completedAt = "2026-09-13T10:00:00Z";
      else if (condition === "sessionError") state.sessionError = true;
      else state.limited = true;
      await render();
      expect(state.showNative).toHaveBeenCalledWith(
        expect.objectContaining({ actions: [], hasReply: false }),
      );
      expect(state.loadProjection).not.toHaveBeenCalled();
      await nativeResponse({ type: "click" });
      expect(state.navigate).toHaveBeenCalled();
    },
  );

  it.each(["linux", "win32"])("keeps web notifications on %s", async (platform) => {
    enableNative(platform);
    await render();
    await complete();
    expect(state.notification).toHaveBeenCalledOnce();
    expect(state.showNative).not.toHaveBeenCalled();
    expect(state.loadProjection).not.toHaveBeenCalled();
  });

  it("keeps the in-app path while focused on mac", async () => {
    enableNative();
    state.focused = true;
    await render();
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledOnce();
    expect(state.showNative).not.toHaveBeenCalled();
    expect(state.loadProjection).not.toHaveBeenCalled();
  });

  it("falls back to web notifications when native presentation fails", async () => {
    enableNative();
    state.showNative.mockResolvedValue(false);
    await render();
    await complete();
    expect(state.notification).toHaveBeenCalledWith(
      "Finished",
      expect.objectContaining({ silent: true }),
    );
  });

  it("ignores replaced notifications and duplicate actions", async () => {
    enableNative();
    await render();
    state.input = true;
    await render();
    const oldListener = [...state.nativeListeners][0]!;
    state.inputRequestId = "request-2";
    state.loadProjection.mockResolvedValue({
      _tag: "Success",
      value: projection({ requestId: "request-2" }),
    });
    await render();
    await act(async () =>
      oldListener({ id: state.showNative.mock.calls[0]![0].id, type: "action", actionIndex: 0 }),
    );
    expect(state.respondToUserInput).not.toHaveBeenCalled();
    const latestListener = [...state.nativeListeners][0]!;
    const response = {
      id: state.showNative.mock.calls[1]![0].id,
      type: "action" as const,
      actionIndex: 0,
    };
    await act(async () => {
      latestListener(response);
      latestListener(response);
    });
    expect(state.respondToUserInput).toHaveBeenCalledOnce();
    expect(state.respondToUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ requestId: "request-2" }) }),
    );
  });

  it("opens the original chat if submitting the answer fails", async () => {
    enableNative();
    await render();
    state.input = true;
    await render();
    state.active = { environmentId: "different", threadId: "different" };
    await render();
    state.respondToUserInput.mockResolvedValue({ _tag: "Failure" });
    await nativeResponse({ type: "action", actionIndex: 0 });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it("suppresses in-app toasts for a chat already visible in the second split pane", async () => {
    const env = EnvironmentId.make("env-1");
    useSplitChatStore.setState({
      split: {
        panes: [
          { environmentId: env, threadId: ThreadId.make("other-thread") },
          { environmentId: env, threadId: ThreadId.make("thread-1") },
        ],
        orientation: "horizontal",
        ratio: 0.5,
      },
    });
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();

    // Moving to a third chat hides the remembered split, so alerts resume.
    state.active = { environmentId: "env-1", threadId: "third-thread" };
    state.completedAt = "2026-09-13T10:01:00.000Z";
    await render();
    expect(state.add).toHaveBeenCalledOnce();
  });
});
