import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  ProviderInstanceId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { deriveThreadFeedPresentation } from "../lib/threadActivity";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedRunEdit } from "./queued-run-edit";

const state = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  visibleItems: null as OrchestrationV2ThreadProjection["visibleTurnItems"] | null,
  effects: [] as Array<() => void>,
  grantedEnvironments: new Set<string>(),
  connectionState: "connected",
  showInteractionModeToggle: true,
  draft: {
    text: "Keep my draft",
    attachments: [] as DraftComposerImageAttachment[],
    modelSelection: undefined as ModelSelection | undefined,
    runtimeMode: undefined as "full-access" | "approval-required" | undefined,
    interactionMode: undefined as "default" | "plan" | undefined,
  },
  outbox: {} as Record<string, QueuedThreadMessage[]>,
  enqueue: vi.fn(async () => undefined),
  clearDraft: vi.fn(),
  feedback: vi.fn(),
  alert: vi.fn(),
  prepareAttachments: vi.fn(),
  edit: null as QueuedRunEdit | null,
  editQueuedRun: vi.fn(),
  releaseEditSave: vi.fn(),
  endEdit: vi.fn(),
  updateSettings: vi.fn(),
  pickModel: vi.fn(),
  rememberModel: vi.fn(),
  pickRuntime: vi.fn(),
  pickInteraction: vi.fn(),
  thread: {
    id: "thread",
    environmentId: "secondary",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    latestRun: null,
    hasPendingUserInput: false,
  },
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void) => {
    state.effects.push(effect);
  },
  useRef: <A>(current: A) => ({ current }),
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepareAttachments }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./queued-run-edit", async () => ({
  ...(await import("./queued-edit-draft-key")),
  claimQueuedRunEditSave: () => state.releaseEditSave,
  endQueuedRunEdit: state.endEdit,
  useQueuedRunEdit: () => state.edit,
  useQueuedRunEditSaving: () => false,
  getQueuedRunEdit: () => state.edit,
}));
vi.mock("./preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadCreation: null,
    selectedEnvironmentRuntime: {
      connectionState: state.connectionState,
      serverConfig: {
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            showInteractionModeToggle: state.showInteractionModeToggle,
            models: [
              { slug: "gpt-5.6-sol", capabilities: null },
              {
                slug: "gpt-5.4",
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Effort",
                      type: "select",
                      currentValue: "high",
                      options: [{ id: "high", label: "High", isDefault: true }],
                    },
                    {
                      id: "serviceTier",
                      label: "Service Tier",
                      type: "select",
                      currentValue: "priority",
                      options: [
                        { id: "default", label: "Standard" },
                        { id: "priority", label: "Fast", isDefault: true },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        environment: { capabilities: {} },
      },
    },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadProjection: () =>
    state.projection === null
      ? null
      : {
          environmentId: EnvironmentId.make("secondary"),
          projection: state.projection,
        },
  useSelectedThreadVisibleTurnItems: () =>
    state.visibleItems ?? state.projection?.visibleTurnItems ?? [],
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: { queueWorkflowAtom: () => Atom.make(null) },
    threadEnvironment: {
      editQueuedRun: state.editQueuedRun,
      uploadFeedback: state.feedback,
      updateMetadata: state.pickModel,
      setRuntimeMode: state.pickRuntime,
      setInteractionMode: state.pickInteraction,
    },
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    dispatchingQueuedMessageIdAtom: Atom.make(null),
    useThreadOutboxMessages: () => state.outbox,
  };
});
vi.mock("./thread-outbox", () => ({ enqueueThreadOutboxMessage: state.enqueue }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    composerContextImportsAtom: Atom.make({}),
    getComposerDraftSnapshot: () => state.draft,
    clearComposerDraftContent: state.clearDraft,
    clearComposerDraft: state.clearDraft,
    setComposerDraftText: (_key: string, text: string) => {
      state.draft.text = text;
    },
    updateComposerDraftSettings: state.updateSettings,
    ensureComposerDraftsLoaded: () => {},
    scheduleUnusedComposerAttachmentCleanup: () => {},
    appendComposerDraftAttachments: vi.fn(),
    appendComposerDraftText: vi.fn(),
    mergeComposerDraftContent: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    useComposerDraft: () => state.draft,
    setStickyComposerModelSelection: state.rememberModel,
  };
});
vi.mock("../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pasteComposerClipboard: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-09-05T00:00:00.000Z",
  }),
}));
vi.mock("../lib/modelOptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/modelOptions")>()),
  isModelSelectionUnavailable: () => false,
}));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));

import { useThreadComposerState } from "./use-thread-composer-state";
import { appAtomRegistry } from "./atom-registry";
import {
  acknowledgedThreadMessagesAtom,
  retainAcknowledgedThreadMessage,
} from "./acknowledged-thread-messages";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const environmentId = EnvironmentId.make("secondary");
const threadId = v2Projection.thread.id;
const runId = RunId.make("run-41");
const startedAt = "2026-10-16T23:21:17.910Z";
const steeredAt = "2026-10-16T23:23:05.493Z";
const completedAt = "2026-10-16T23:29:38.769Z";
const steer: QueuedThreadMessage = {
  environmentId,
  threadId,
  messageId: MessageId.make("e4d44925-eb16-4d2c-b56b-d3466723beac"),
  commandId: CommandId.make("steer-command"),
  text: "Show this while you work",
  attachments: [],
  dispatchMode: "auto",
  createdAt: steeredAt,
};

function itemBase(id: string, ordinal: number, at = startedAt) {
  const timestamp = DateTime.makeUnsafe(at);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function project(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));
}

function renderFeed() {
  state.effects = [];
  const composer = useThreadComposerState();
  for (const effect of state.effects) effect();
  return deriveThreadFeedPresentation(
    composer.selectedThreadFeed,
    composer.selectedThreadActivityRun,
    new Set(),
    new Set(),
    composer.activeWorkStartedAt,
  );
}

beforeEach(() => {
  state.outbox = {};
  state.thread.id = threadId;
  state.thread.hasPendingUserInput = false;
  state.effects = [];
  state.projection = null;
  state.visibleItems = null;
  state.thread.runtime = null;
  state.draft.attachments = [];
  state.edit = null;
  state.alert.mockClear();
  state.editQueuedRun.mockClear();
  state.prepareAttachments.mockReset();
  state.releaseEditSave.mockClear();
  state.endEdit.mockClear();
  state.draft.modelSelection = undefined;
  state.draft.runtimeMode = undefined;
  state.draft.interactionMode = undefined;
  state.pickModel.mockClear();
  state.rememberModel.mockClear();
  state.pickRuntime.mockClear();
  state.pickInteraction.mockClear();
  state.connectionState = "connected";
  state.grantedEnvironments.clear();
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
});

it("shows an upload failure and keeps the queued message edit available to retry", async () => {
  state.grantedEnvironments.add("secondary");
  state.edit = {
    runId,
    messageId: MessageId.make("queued-message"),
    originalText: "Original message",
    existingAttachments: [],
  };
  state.draft.text = "Edited message with photo";
  state.draft.attachments = [
    {
      id: "photo",
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 123,
      fileUri: "file:///photo.jpg",
      previewUri: "file:///photo.jpg",
    },
  ];
  state.prepareAttachments.mockRejectedValueOnce(new Error("Connection lost during upload."));

  await useThreadComposerState().onSendMessage();

  expect(state.alert).toHaveBeenCalledWith(
    "Could not upload queued message attachments",
    "Connection lost during upload.",
  );
  expect(state.editQueuedRun).not.toHaveBeenCalled();
  expect(state.endEdit).not.toHaveBeenCalled();
  expect(state.releaseEditSave).toHaveBeenCalledOnce();
});

describe("mobile send model options", () => {
  it.each(["starting", "running"] as const)(
    "saves a %s follow-up as auto for delayed delivery",
    async (status) => {
      state.grantedEnvironments.add("secondary");
      state.thread.runtime = { status, activeRunId: "run" } as never;
      state.draft.text = "Follow up";
      state.enqueue.mockClear();
      await useThreadComposerState().onSendMessage();
      expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dispatchMode: "auto" }));
      state.enqueue.mockClear();
      await useThreadComposerState().onSendMessage("queue");
      expect(state.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchMode: "queue" }),
      );
    },
  );
  it("sends a normal message while a secret card is pending", async () => {
    state.grantedEnvironments.add("secondary");
    state.projection = {
      ...v2Projection,
      turnItems: [
        {
          ...itemBase("secret", 1),
          type: "secret_request",
          status: "waiting",
          secretStatus: "pending",
          label: "API key",
          reason: "Needed later",
        },
      ],
    };
    state.thread.hasPendingUserInput = true;
    state.visibleItems = project(state.projection.turnItems);
    state.draft.text = "is that the gemini api key?";
    await useThreadComposerState().onSendMessage();
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: "is that the gemini api key?" }),
    );
  });

  it("keeps follow-ups queued during compaction", async () => {
    state.grantedEnvironments.add("secondary");
    state.thread.runtime = { status: "running", activeRunId: runId } as never;
    state.visibleItems = project([
      {
        ...itemBase("compact", 1),
        type: "user_message",
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "turn_start",
        messageId: MessageId.make("compact"),
        text: "/compact",
        attachments: [],
      },
    ]);
    state.draft.text = "Follow up";
    state.enqueue.mockClear();
    await useThreadComposerState().onSendMessage();
    expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dispatchMode: "queue" }));
  });

  it("keeps the composer draft until the outbox has saved it", async () => {
    state.grantedEnvironments.add("secondary");
    const gate = Promise.withResolvers<void>();
    state.enqueue.mockReturnValueOnce(gate.promise.then(() => undefined));
    state.clearDraft.mockClear();
    const sending = useThreadComposerState().onSendMessage();
    expect(state.clearDraft).not.toHaveBeenCalled();
    gate.resolve();
    await sending;
    expect(state.clearDraft).toHaveBeenCalledOnce();
  });

  it("leaves the draft intact when saving the queued send fails", async () => {
    state.grantedEnvironments.add("secondary");
    state.enqueue.mockRejectedValueOnce(new Error("disk full"));
    state.clearDraft.mockClear();
    expect(await useThreadComposerState().onSendMessage()).toBeNull();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it.each(["connected", "disconnected"])(
    "freezes speed and effort before the %s outbox accepts a send",
    async (connectionState) => {
      state.connectionState = connectionState;
      state.grantedEnvironments.add("secondary");
      state.enqueue.mockClear();
      state.draft.text = "Send with Fast";
      const composer = useThreadComposerState();
      await composer.onSendMessage();
      expect(state.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          },
        }),
      );
    },
  );
});

describe("steered messages in the mobile feed", () => {
  it("shows a receipt while outbox cleanup and the subscription are still pending", () => {
    state.outbox[`${environmentId}:${threadId}`] = [steer];
    expect(useThreadComposerState().selectedThreadQueuedMessages).toEqual([steer]);
    retainAcknowledgedThreadMessage(steer);
    const composer = useThreadComposerState();
    expect(composer.selectedThreadFeed).toContainEqual(
      expect.objectContaining({ id: steer.messageId, acknowledged: true }),
    );
    expect(composer.selectedThreadQueuedMessages).toEqual([]);

    const edited = { ...steer, text: "edited after dispatch" };
    state.outbox[`${environmentId}:${threadId}`] = [edited];
    const replacement = useThreadComposerState();
    expect(replacement.selectedThreadQueuedMessages).toEqual([edited]);
    expect(replacement.selectedThreadFeed.some((entry) => entry.id === edited.messageId)).toBe(
      false,
    );
  });

  it.each(["notification", "user_message"] as const)(
    "keeps a steer visible across message and turn-item echoes in a %s-started run",
    (trigger) => {
      const triggerId = MessageId.make("run-trigger");
      const first: OrchestrationV2TurnItem =
        trigger === "notification"
          ? {
              ...itemBase("notice", 41_000_001),
              type: "notification",
              source: { kind: "background_task" },
              outcome: "completed",
              summary: "Delegated task completed",
            }
          : {
              ...itemBase("prompt", 41_000_001),
              type: "user_message",
              messageId: triggerId,
              createdBy: "user",
              creationSource: "mobile",
              inputIntent: "turn_start",
              text: "Start working",
              attachments: [],
            };
      const work: OrchestrationV2TurnItem = {
        ...itemBase("work", 41_000_003),
        type: "command_execution",
        input: "git status",
        output: "clean",
        exitCode: 0,
      };
      const steeredItem: OrchestrationV2TurnItem = {
        ...itemBase("steer", 41_000_004, steeredAt),
        type: "user_message",
        messageId: steer.messageId,
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "steer",
        text: steer.text,
        attachments: [],
      };
      let projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: runId,
            threadId,
            ordinal: 41,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: triggerId,
            rootNodeId: NodeId.make("root"),
            activeAttemptId: null,
            status: "running",
            queuePosition: null,
            requestedAt: DateTime.makeUnsafe(startedAt),
            startedAt: DateTime.makeUnsafe(startedAt),
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        messages: [
          {
            id: triggerId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: trigger === "notification" ? "Delegated task completed" : "Start working",
            createdBy: trigger === "notification" ? "system" : "user",
            creationSource: trigger === "notification" ? "server" : "mobile",
            ...(trigger === "notification"
              ? {
                  notification: {
                    source: { kind: "background_task" },
                    outcome: "completed",
                    summary: "Delegated task completed",
                  },
                }
              : {}),
            attachments: [],
            streaming: false,
            createdAt: DateTime.makeUnsafe(startedAt),
            updatedAt: DateTime.makeUnsafe(startedAt),
          },
        ],
        turnItems: [first, work],
        visibleTurnItems: project([first, work]),
      };
      state.projection = projection;
      retainAcknowledgedThreadMessage(steer);
      const beforeEcho = renderFeed();
      expect(beforeEcho.findIndex((entry) => entry.id === steer.messageId)).toBeGreaterThan(
        beforeEcho.findIndex((entry) => entry.type === "work-toggle"),
      );

      // message.updated arrives before turn-item.updated. The feed must keep
      // the optimistic bubble until the visible timeline can replace it.
      projection = {
        ...projection,
        messages: [
          ...projection.messages,
          {
            id: steer.messageId,
            threadId,
            runId,
            role: "user",
            nodeId: null,
            text: steer.text,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "mobile",
            createdAt: DateTime.makeUnsafe(steeredAt),
            updatedAt: DateTime.makeUnsafe(steeredAt),
          },
        ],
      };
      state.projection = projection;
      renderFeed();
      const duringEcho = renderFeed();
      expect(duringEcho.filter((entry) => entry.id === steer.messageId)).toHaveLength(1);
      expect(duringEcho.findIndex((entry) => entry.id === steer.messageId)).toBeGreaterThan(
        duringEcho.findIndex((entry) => entry.type === "work-toggle"),
      );

      const reply: OrchestrationV2TurnItem = {
        ...itemBase("reply", 41_000_005, completedAt),
        type: "assistant_message",
        messageId: MessageId.make("reply"),
        text: "Done",
        streaming: false,
      };
      projection = {
        ...projection,
        turnItems: [first, work, steeredItem, reply],
        visibleTurnItems: project([first, work, steeredItem, reply]),
      };
      state.projection = projection;
      renderFeed();
      expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([]);
      const running = renderFeed();
      expect(running.filter((entry) => entry.id === steer.messageId)).toHaveLength(1);
      expect(running.findIndex((entry) => entry.id === steer.messageId)).toBeGreaterThan(
        running.findIndex((entry) => entry.type === "work-toggle"),
      );
      expect(running.findIndex((entry) => entry.id === steer.messageId)).toBeLessThan(
        running.findIndex((entry) => entry.id === "reply"),
      );
      expect(running.some((entry) => entry.type === "run-fold")).toBe(false);

      projection = {
        ...projection,
        runs: projection.runs.map((run) => ({
          ...run,
          status: "completed",
          completedAt: DateTime.makeUnsafe(completedAt),
        })),
      };
      state.projection = projection;
      const settled = renderFeed();
      expect(settled.filter((entry) => entry.id === steer.messageId)).toHaveLength(1);
      expect(settled.some((entry) => entry.type === "run-fold")).toBe(true);
      expect(settled.findIndex((entry) => entry.id === steer.messageId)).toBeLessThan(
        settled.findIndex((entry) => entry.id === "reply"),
      );
    },
  );
});

it.each(["queued", "cancelled", "rolled_back"] as const)(
  "removes acknowledged input from the feed when its own run is %s",
  (status) => {
    state.projection = {
      ...v2Projection,
      messages: [
        {
          id: steer.messageId,
          threadId,
          runId,
          role: "user",
          nodeId: null,
          text: steer.text,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "mobile",
          createdAt: DateTime.makeUnsafe(steeredAt),
          updatedAt: DateTime.makeUnsafe(steeredAt),
        },
      ],
      runs: [
        {
          id: runId,
          threadId,
          ordinal: 41,
          providerInstanceId: v2Projection.thread.providerInstanceId,
          modelSelection: v2Projection.thread.modelSelection,
          providerThreadId: null,
          userMessageId: steer.messageId,
          rootNodeId: NodeId.make("root"),
          activeAttemptId: null,
          status,
          queuePosition: status === "queued" ? 0 : null,
          requestedAt: DateTime.makeUnsafe(steeredAt),
          startedAt: null,
          completedAt: status === "queued" ? null : DateTime.makeUnsafe(completedAt),
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
    };
    retainAcknowledgedThreadMessage(steer);
    if (status === "queued") {
      const complete = state.projection;
      state.projection = { ...complete, messages: [] };
      expect(renderFeed().find((entry) => entry.id === steer.messageId)).toMatchObject({
        message: { text: steer.text },
      });
      state.projection = complete;
    }
    state.outbox[`${environmentId}:${threadId}`] = [steer];
    expect(renderFeed().some((entry) => entry.id === steer.messageId)).toBe(false);
    expect(useThreadComposerState().selectedThreadQueuedMessages).toEqual([]);
    state.outbox = {};
    renderFeed();
    expect(renderFeed().some((entry) => entry.id === steer.messageId)).toBe(false);
    expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([]);
  },
);

describe("existing mobile chat follows shared settings", () => {
  it("ignores legacy settings, follows a Mac pick while open, and preserves typed text", async () => {
    state.grantedEnvironments.add("secondary");
    state.draft.modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "stale-phone-model",
    };
    state.draft.runtimeMode = "approval-required";
    state.draft.interactionMode = "plan";
    state.draft.text = "Text being typed";
    state.clearDraft.mockClear();
    const before = useThreadComposerState();
    expect(before.modelSelection).toEqual(state.thread.modelSelection);
    expect(before.runtimeMode).toBe("full-access");
    expect(before.interactionMode).toBe("default");
    const previous = state.thread.modelSelection;
    state.thread.modelSelection = {
      ...previous,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as typeof previous;
    try {
      const after = useThreadComposerState();
      expect(after.modelSelection).toBe(state.thread.modelSelection);
      expect(state.draft.text).toBe("Text being typed");
      expect(state.clearDraft).not.toHaveBeenCalled();
      state.enqueue.mockClear();
      await after.onSendMessage();
      expect(state.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSelection: expect.objectContaining({
            model: "gpt-5.6-sol",
            options: expect.arrayContaining([{ id: "reasoningEffort", value: "high" }]),
          }),
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );
    } finally {
      state.thread.modelSelection = previous;
    }
  });

  it("publishes model/options and both modes without sending or changing draft text", () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    const text = state.draft.text;
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    composer.onUpdateModelSelection(modelSelection);
    composer.onUpdateRuntimeMode("approval-required");
    composer.onUpdateInteractionMode("plan");
    expect(state.pickModel).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: {
        threadId,
        modelSelection: {
          ...modelSelection,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      },
    });
    expect(state.pickRuntime).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId, runtimeMode: "approval-required" },
    });
    expect(state.pickInteraction).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId, interactionMode: "plan" },
    });
    expect(state.draft.text).toBe(text);
  });

  it("does not publish picks without operate permission", () => {
    const composer = useThreadComposerState();
    composer.onUpdateModelSelection({ instanceId: ProviderInstanceId.make("codex"), model: "new" });
    composer.onUpdateRuntimeMode("approval-required");
    composer.onUpdateInteractionMode("plan");
    expect(state.pickModel).not.toHaveBeenCalled();
    expect(state.pickRuntime).not.toHaveBeenCalled();
    expect(state.pickInteraction).not.toHaveBeenCalled();
  });

  it("can switch this chat's plan without changing the model new chats start on", () => {
    state.grantedEnvironments.add("secondary");
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    useThreadComposerState().onUpdateModelSelection(selection, { remember: false });
    expect(state.pickModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadId,
          modelSelection: expect.objectContaining(selection),
        }),
      }),
    );
    expect(state.rememberModel).not.toHaveBeenCalled();
    useThreadComposerState().onUpdateModelSelection(selection);
    expect(state.rememberModel).toHaveBeenCalledWith(selection);
  });
});

it("saves Build mode with a pick whose provider cannot use Plan mode", () => {
  state.grantedEnvironments.add("secondary");
  const previousMode = state.thread.interactionMode;
  state.thread.interactionMode = "plan";
  state.showInteractionModeToggle = false;
  try {
    useThreadComposerState().onUpdateModelSelection({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });
    expect(state.pickInteraction).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId, interactionMode: "default" },
    });
  } finally {
    state.thread.interactionMode = previousMode;
    state.showInteractionModeToggle = true;
  }
});
