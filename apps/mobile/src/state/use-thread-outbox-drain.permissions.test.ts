import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  threadPresent: true,
  connected: true,
  modelUnavailable: false,
  alert: vi.fn(),
  draftText: "Keep this draft separate",
  cleanups: [] as Array<() => void>,
  start: vi.fn(),
  prepareCommand: vi.fn(),
  write: vi.fn(),
  metadata: vi.fn(),
  runtime: vi.fn(),
  interaction: vi.fn(),
  prepare: vi.fn(),
  checkout: vi.fn(),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  thread: {
    environmentId: "secondary",
    id: "thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
  },
  config: {
    attachmentReceiptReplay: undefined as boolean | undefined,
    providers: [{ instanceId: "codex", driver: "codex" }],
    environment: { capabilities: { fileAttachments: { maxUploadBytes: 1024 } } },
  },
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../connection/network-recovery", () => ({ subscribeNetworkRecovery: () => () => {} }));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) state.cleanups.push(cleanup);
  },
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(initial: A) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
  useEnvironmentsWithScope: () => state.grantedEnvironments,
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useThreadShells: () => (state.threadPresent ? [state.thread] : []),
  useServerConfigs: () => new Map([["secondary", state.config]]),
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      prepareTurn: state.prepareCommand,
      submitPreparedTurn: state.start,
      updateMetadata: state.metadata,
      setRuntimeMode: state.runtime,
      setInteractionMode: state.interaction,
    },
    environmentThreadShells: { threadShellsAtom: Atom.make([state.thread]) },
  };
});
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./git", () => ({ gitEnvironment: { preparePullRequestThread: state.checkout } }));
vi.mock("../lib/modelOptions", () => ({
  isModelSelectionUnavailable: () => state.modelUnavailable,
  describeUnavailableModelSelection: () => ({ title: "Disabled", detail: "Project override" }),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      {
        environmentId: "secondary",
        connectionState: state.connected ? "connected" : "reconnecting",
      },
    ],
  }),
}));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: state.write,
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  await import("./thread-outbox");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["secondary", "live"]]),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(),
    getComposerDraftSnapshot: vi.fn(() => ({ text: state.draftText, attachments: [] })),
    mergeComposerDraftContent: vi.fn(async (_key: string, input: { text: string }) => {
      state.draftText += `\n${input.text}`;
    }),
    replaceComposerDraftAttachments: vi.fn(),
    undoComposerDraftMerge: vi.fn(),
    updateComposerDraftSettings: vi.fn(),
    waitForComposerDraftsLoaded: vi.fn(),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox";
import { environmentThreadShells } from "./threads";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const message = (overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Keep this queued",
  attachments: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});
const writableShells = environmentThreadShells.threadShellsAtom as Atom.Writable<
  ReadonlyArray<EnvironmentThreadShell>,
  ReadonlyArray<EnvironmentThreadShell>
>;
const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
    if (id === null) settled.resolve();
  });
  useThreadOutboxDrain();
  return settled.promise.finally(release);
}

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.threadPresent = true;
  state.connected = true;
  state.modelUnavailable = false;
  state.config.attachmentReceiptReplay = undefined;
  state.alert.mockReset();
  appAtomRegistry.set(writableShells, [state.thread] as never);
  state.draftText = "Keep this draft separate";
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  for (const command of [
    state.start,
    state.metadata,
    state.runtime,
    state.interaction,
    state.checkout,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.write.mockReset().mockResolvedValue(undefined);
  state.prepareCommand.mockReset().mockImplementation(async ({ input }) =>
    AsyncResult.success(
      input.bootstrap
        ? {
            commandId: input.commandId,
            threadId: input.threadId,
            ...input.bootstrap.createThread,
            initialMessage: input.message,
            workspaceStrategy: { type: "root" },
          }
        : {
            type: "message.dispatch",
            commandId: input.commandId,
            threadId: input.threadId,
            messageId: input.message.messageId,
            text: input.message.text,
            attachments: input.message.attachments,
            createdBy: "user",
            creationSource: "mobile",
            dispatchMode: { type: "start_immediately" },
          },
    ),
  );
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
});

describe("queued PR checkout", () => {
  const queuedPullRequest = () =>
    message({
      threadId: ThreadId.make("new-pr-thread"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("project"),
        projectCwd: "/repo",
        workspaceMode: "worktree",
        branch: "fork/feature",
        worktreePath: null,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    });
  const preparedCheckout = {
    branch: "pr-123",
    worktreePath: "/repo/.t3/worktrees/pr-123",
    isOnPullRequestHead: true,
  };

  it("waits for the provider's PR checkout and launches in that worktree", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    const started = Promise.withResolvers<void>();
    const checkout =
      Promise.withResolvers<AsyncResult.AsyncResult<typeof preparedCheckout, Error>>();
    state.checkout.mockImplementationOnce(() => {
      started.resolve();
      return checkout.promise;
    });
    const drained = runDrain();
    await started.promise;
    expect(state.start).not.toHaveBeenCalled();
    expect(state.checkout).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { cwd: "/repo", reference: "https://github.com/acme/repo/pull/123", mode: "worktree" },
    });
    checkout.resolve(AsyncResult.success(preparedCheckout));
    await drained;
    expect(state.start).toHaveBeenCalledOnce();
    const bootstrap = state.prepareCommand.mock.calls[0]?.[0].input.bootstrap;
    expect(bootstrap.createThread).toMatchObject({
      branch: "pr-123",
      worktreePath: preparedCheckout.worktreePath,
    });
    expect(bootstrap.prepareWorktree).toBeUndefined();
    expect(remaining()).toEqual([]);
  });

  it("keeps the PR source queued on a transport failure without starting the agent", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("restores the PR draft when the reused worktree cannot reach the PR head", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    state.checkout.mockResolvedValueOnce(
      AsyncResult.success({ ...preparedCheckout, isOnPullRequestHead: false }),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([]);
    const { updateComposerDraftSettings } = await import("./use-composer-drafts");
    expect(updateComposerDraftSettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workspaceSelection: expect.objectContaining({
          pullRequestReference: queuedPullRequest().creation?.pullRequestReference,
        }),
      }),
    );
  });

  it("stops launch if operation access is revoked while checking out the PR", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("does not launch a stale task edited while the PR checkout was running", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    const edited = { ...queued, text: "Updated instructions" };
    state.checkout.mockImplementationOnce(async () => {
      await state.manager.update(edited);
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([edited]);
  });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("queued task operation access", () => {
  it("keeps a send through reconnect and delivers the queued command exactly once", async () => {
    state.grantedEnvironments.add("secondary");
    state.connected = false;
    const queued = message();
    await state.manager.enqueue(queued);
    useThreadOutboxDrain();
    expect(remaining()).toEqual([queued]);
    expect(state.start).not.toHaveBeenCalled();
    state.connected = true;
    await runDrain();
    useThreadOutboxDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("parks a connected read-only target, then delivers its unchanged queue after a grant", async () => {
    const queued = message();
    await state.manager.enqueue(queued);
    useThreadOutboxDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    state.grantedEnvironments.add("secondary");
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("never replays stale queued model/options or modes over a remote selection", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = message({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "different-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    await state.manager.enqueue(queued);
    await runDrain();
    expect(state.runtime).not.toHaveBeenCalled();
    expect(state.interaction).not.toHaveBeenCalled();
    expect(state.start).toHaveBeenCalledOnce();
    // Omitting the model lets the server choose atomically, even if a remote
    // pick lands after the attachments upload and before this command commits.
    expect(state.start.mock.calls[0]?.[0].input).not.toHaveProperty("modelSelection");
    expect(remaining()).toEqual([]);
  });

  it.each([
    { isCreation: false, accepted: false },
    { isCreation: true, accepted: false },
    { isCreation: false, accepted: true },
    { isCreation: true, accepted: true },
  ])(
    "preserves a rejected queue but removes an accepted turn after access loss (new task: $isCreation, accepted: $accepted)",
    async ({ isCreation, accepted }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      const started = Promise.withResolvers<void>();
      const delivery = Promise.withResolvers<AsyncResult.AsyncResult<void, Error>>();
      state.start.mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      });
      const drained = runDrain();
      await started.promise;
      state.grantedEnvironments.delete("secondary");
      delivery.resolve(
        accepted
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(new Error("This connection cannot control this task."))),
      );
      await drained;

      expect(remaining()).toEqual(
        accepted ? [] : [expect.objectContaining({ ...queued, attempted: expect.any(Object) })],
      );
      expect(state.draftText).toBe("Keep this draft separate");
      if (!accepted) {
        state.grantedEnvironments.add("secondary");
        await runDrain();
        expect(state.start).toHaveBeenCalledTimes(2);
        expect(remaining()).toEqual([]);
        expect(state.draftText).toBe("Keep this draft separate");
      }
    },
  );

  it.each([
    { isCreation: false, uploadFails: false },
    { isCreation: true, uploadFails: false },
    { isCreation: false, uploadFails: true },
    { isCreation: true, uploadFails: true },
  ])(
    "keeps the message queued after upload revocation (new task: $isCreation, upload fails: $uploadFails)",
    async ({ isCreation, uploadFails }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        state.grantedEnvironments.delete("secondary");
        if (uploadFails) throw new Error("This connection cannot upload attachments.");
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      await runDrain();
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([queued]);
    },
  );
});

describe("missing queued project", () => {
  it("restores the queued creation as a draft instead of discarding it", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = message({
      threadId: ThreadId.make("missing-project-thread"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("missing"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    });
    await state.manager.enqueue(queued);
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([]);
    const { mergeComposerDraftContent } = await import("./use-composer-drafts");
    expect(mergeComposerDraftContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: queued.text }),
    );
  });
});

describe("missing queued chat", () => {
  it("marks every message in a missing chat for recovery", async () => {
    state.threadPresent = false;
    appAtomRegistry.set(writableShells, []);
    const first = message();
    const second = message({
      messageId: MessageId.make("second"),
      commandId: CommandId.make("second-command"),
      text: "Next message",
      createdAt: "2026-09-05T00:00:01.000Z",
    });
    await state.manager.enqueue(first);
    await state.manager.enqueue(second);
    await runDrain();
    await runDrain();
    expect(remaining()).toEqual([
      { ...first, recoveryReason: "missing-thread" },
      { ...second, recoveryReason: "missing-thread" },
    ]);
  });

  it("persists the recovery state and keeps the attachment when the chat disappears", async () => {
    state.threadPresent = false;
    appAtomRegistry.set(writableShells, []);
    const queued = message({
      attachments: [
        {
          type: "file",
          id: "file",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          fileUri: "file:///note.txt",
        },
      ],
    });
    await state.manager.enqueue(queued);
    await runDrain();
    expect(remaining()).toEqual([{ ...queued, recoveryReason: "missing-thread" }]);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
  });
});

function coldAttempt() {
  const row = message();
  const pending = {
    type: "file" as const,
    id: "pending-00000000-0000-4000-8000-000000000003",
    name: "proof.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
  };

  return decodeQueuedThreadMessage(
    JSON.parse(
      JSON.stringify(
        encodeQueuedThreadMessage({
          ...row,
          attachments: [
            {
              ...pending,
              id: "phone-file",
              fileUri: "file:///expired",
              uploadedAttachmentId: pending.id,
              uploadEnvironmentId: row.environmentId,
            },
          ],
          attempted: {
            type: "message.dispatch",
            commandId: row.commandId,
            threadId: row.threadId,
            messageId: row.messageId,
            text: row.text,
            attachments: [pending],
            createdBy: "user",
            creationSource: "mobile",
            dispatchMode: { type: "start_immediately" },
          },
        }),
      ),
    ),
  );
}

it.each([true, undefined])(
  "drains an attempted send after cold restart with replay capability %s",
  async (capability) => {
    state.config.attachmentReceiptReplay = capability;
    state.grantedEnvironments.add("secondary");
    state.modelUnavailable = true;
    state.draftText = "";
    const row = coldAttempt();
    const messages = new Map([[row.commandId, row.messageId]]);
    state.start.mockImplementation(async ({ input }) => {
      expect(input.commandId).toBe(row.commandId);
      expect(input.messageId).toBe(row.messageId);
      expect(input.attachments[0].id).toBe(row.attachments[0]?.uploadedAttachmentId);
      messages.set(input.commandId, input.messageId);
      return AsyncResult.success({ sequence: 9 });
    });
    await state.manager.enqueue(row);
    await runDrain();
    expect(remaining()).toEqual([]);
    expect(messages.size).toBe(1);
    expect(state.start).toHaveBeenCalledTimes(capability ? 1 : 0);
    expect(state.draftText.trim()).toBe(capability ? "" : row.text);
    expect(state.prepare).not.toHaveBeenCalled();
  },
);

it.each(["refused", "unknown", "different id"] as const)(
  "restores a marked row only for its own definite refusal: %s",
  async (outcome) => {
    state.config.attachmentReceiptReplay = true;
    state.grantedEnvironments.add("secondary");
    state.modelUnavailable = true;
    const row = coldAttempt();
    state.start.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail({
          _tag: "OrchestrationV2DispatchCommandError",
          commandId: outcome === "different id" ? "other" : row.commandId,
          commandType: "message.dispatch",
          message: "Refused",
          ...(outcome === "unknown" ? {} : { notAccepted: true }),
        }),
      ),
    );
    await state.manager.enqueue(row);
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    if (outcome === "refused") {
      expect(remaining()).toEqual([]);
      useThreadOutboxDrain();
      expect(state.draftText.split(row.text)).toHaveLength(2);
    } else {
      expect(remaining()).toEqual([row]);
      expect(state.draftText).toBe("Keep this draft separate");
    }
  },
);

it("waits for the attempt write before the first RPC and retries a failed write without sending", async () => {
  state.grantedEnvironments.add("secondary");
  state.config.attachmentReceiptReplay = true;
  await state.manager.enqueue(message());
  const writing = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  state.write.mockImplementationOnce(() => {
    writing.resolve();
    return write.promise;
  });
  const drain = runDrain();
  await writing.promise;
  expect(state.start).not.toHaveBeenCalled();
  write.reject(new Error("disk unavailable"));
  await drain;
  expect(state.start).not.toHaveBeenCalled();
  expect(remaining()[0]?.attempted).toBeUndefined();
  await runDrain();
  expect(state.start).toHaveBeenCalledOnce();
  expect(state.write.mock.calls.at(-1)?.[0].attempted).toEqual(
    state.start.mock.calls[0]?.[0].input,
  );
  expect(remaining()).toEqual([]);
});

it("replays an attempted launch with its saved workspace when the chat is already in the shell", async () => {
  state.grantedEnvironments.add("secondary");
  state.config.attachmentReceiptReplay = true;
  state.modelUnavailable = true;
  const row = message();
  const attempt = {
    commandId: row.commandId,
    threadId: row.threadId,
    projectId: ProjectId.make("project"),
    title: "Title",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    initialMessage: { messageId: row.messageId, text: row.text, attachments: [] },
    workspaceStrategy: { type: "existing_worktree" as const, worktreePath: "/repo/worktree" },
  };
  await state.manager.enqueue(
    decodeQueuedThreadMessage(
      encodeQueuedThreadMessage({
        ...row,
        creation: {
          projectId: attempt.projectId,
          workspaceMode: "local",
          branch: null,
          worktreePath: null,
        },
        attempted: attempt,
      }),
    ),
  );
  await runDrain();
  expect(state.start).toHaveBeenCalledWith({ environmentId: row.environmentId, input: attempt });
  expect(state.checkout).not.toHaveBeenCalled();
  expect(state.prepare).not.toHaveBeenCalled();
  expect(remaining()).toEqual([]);
  expect(state.draftText).toBe("Keep this draft separate");
});

it("keeps a saved pending-task edit when an earlier launch replays after restart", async () => {
  const row = message({
    creation: {
      projectId: ProjectId.make("p"),
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    },
  });
  const attempt = {
    commandId: row.commandId,
    threadId: row.threadId,
    projectId: ProjectId.make("p"),
    title: "Original",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: { type: "root" as const },
    initialMessage: { messageId: row.messageId, text: row.text, attachments: [] },
  };
  await state.manager.enqueue({ ...row, attempted: attempt });
  await state.manager.update({ ...row, text: "An edit I still need" });
  const saved = remaining()[0]!;
  expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(saved))).toMatchObject({
    attempted: attempt,
    editedAfterAttempt: true,
  });
  state.grantedEnvironments.add("secondary");
  state.config.attachmentReceiptReplay = true;
  await runDrain();
  expect(state.start).toHaveBeenCalledWith({ environmentId: row.environmentId, input: attempt });
  expect(state.draftText).toContain("An edit I still need");
  expect(remaining()).toEqual([]);
});
