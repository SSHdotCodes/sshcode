import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  crypto: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.succeed(undefined),
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);
  });

  it("extracts Role, Prompt, and Model from agy 1.5 invoke_subagent rawInput", () => {
    const withModel = flavor.extractSubagentUpdate?.({
      toolCallId: "call_subagent_1",
      title: "Run invoke_subagent",
      kind: "other",
      status: "inProgress",
      data: {
        rawInput: {
          Role: "Codebase Researcher",
          Prompt: "Audit Antigravity ACP turn usage",
          TypeName: "research",
          Model: "flash_lite",
        },
      },
    });
    assert.deepInclude(withModel, {
      nativeTaskId: "call_subagent_1",
      title: "Codebase Researcher",
      prompt: "Audit Antigravity ACP turn usage",
      model: "flash_lite",
      status: "running",
    });

    const inherited = flavor.extractSubagentUpdate?.({
      toolCallId: "call_subagent_2",
      title: "Run invoke_subagent",
      kind: "other",
      status: "inProgress",
      data: {
        rawInput: {
          Prompt: "Check the logs",
          TypeName: "research",
          Model: "inherit",
        },
      },
    });
    assert.deepInclude(inherited, {
      nativeTaskId: "call_subagent_2",
      title: "research",
      prompt: "Check the logs",
      model: null,
      status: "running",
    });
  });

  it("projects failed swarm launches with their error and leaves swarm status calls alone", () => {
    const launch = {
      toolCallId: "swarm-add",
      title: "Run swarm",
      kind: "other",
      status: "failed",
      detail: "Worker could not start.",
      data: { rawInput: { action: "add", name: "worker", brief: "Count lines" } },
    } as const;
    assert.deepInclude(flavor.extractSubagentUpdate?.(launch), {
      nativeTaskId: launch.toolCallId,
      title: "worker",
      status: "failed",
      result: launch.detail,
    });
    assert.isUndefined(
      flavor.extractSubagentUpdate?.({
        ...launch,
        data: { rawInput: { action: "status" } },
      }),
    );
  });

  it("maps runtime modes to the agent's native permission modes", () => {
    const mode = (runtimeMode: "approval-required" | "auto-accept-edits" | "full-access") =>
      flavor.sessionModeForPolicy?.(
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: "default",
          cwd: "/workspace",
        }),
      );
    assert.equal(mode("approval-required"), "default");
    assert.equal(mode("auto-accept-edits"), "auto_edit");
    assert.equal(mode("full-access"), "yolo");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("advertises only the approval decisions the request can honor", () => {
    const options = flavor.approvalOptions?.(
      permissionRequest("tool_1", [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ]),
    );
    assert.deepEqual(
      options?.map((option) => option.decision),
      ["accept", "decline", "cancel"],
    );
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("Antigravity ACP cancellation", () => {
  it.effect.each([false, true])(
    "only reuses a session after native cancellation succeeds (exit=%s)",
    (exitOnCancel) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "antigravity-cancel-" });
        const running = yield* Deferred.make<void>();
        const cancelReceived = yield* Deferred.make<void>();
        const requests: { method: string; payload: unknown }[] = [];
        const runtime = yield* makeAntigravityAcpRuntime({
          childProcessSpawner,
          cwd,
          spawn: {
            command: process.execPath,
            args: [
              yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
            ],
            cwd,
            env: {
              HOME: cwd,
              T3_ACP_ANTIGRAVITY: "1",
              T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1",
              T3_ACP_EXIT_ON_CANCEL: exitOnCancel ? "1" : "0",
            },
          },
          requestLogger: (event) =>
            Effect.sync(() => {
              if (event.status === "started")
                requests.push({ method: event.method, payload: event.payload });
            }),
          protocolLogging: {
            logIncoming: true,
            logger: (event) =>
              Effect.gen(function* () {
                if (event.direction !== "incoming" || typeof event.payload !== "string") return;
                if (event.payload.includes("native-cancel-tool"))
                  yield* Deferred.succeed(running, undefined);
                if (event.payload.includes("native-cancel-received"))
                  yield* Deferred.succeed(cancelReceived, undefined);
              }),
          },
        });
        const started = yield* runtime.start();
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            event._tag === "EventStreamBarrier"
              ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const first = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "original" }] })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(running);
        const cancel = yield* runtime.cancel.pipe(Effect.forkScoped);
        if (exitOnCancel) {
          assert.isTrue(Exit.isFailure(yield* Fiber.await(cancel)));
          assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
        } else {
          yield* Deferred.await(cancelReceived);
          assert.equal(requests.filter((request) => request.method === "session/prompt").length, 1);
          yield* runtime.request("_test/finish-cancel", {});
          yield* Fiber.join(cancel);
          assert.equal((yield* Fiber.join(first)).stopReason, "cancelled");
          assert.equal(
            (yield* runtime.prompt({ prompt: [{ type: "text", text: "new direction" }] }))
              .stopReason,
            "end_turn",
          );
        }
        assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
        assert.equal(requests.filter((request) => request.method === "session/new").length, 1);
        const prompts = requests.filter((request) => request.method === "session/prompt");
        assert.lengthOf(prompts, exitOnCancel ? 1 : 2);
        assert.isTrue(
          prompts.every(
            (request) => (request.payload as { sessionId: string }).sessionId === started.sessionId,
          ),
        );
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* Crypto.Crypto;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        defaultModel: Effect.succeed(undefined),
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const initialize = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { clientCapabilities?: { fs?: unknown }; clientInfo?: { name?: string } };
            },
        )
        .find((request) => request.method === "initialize");
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "zed");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = resolveAttachmentPath({
        attachmentsDir: host.paths.attachmentsDir,
        attachment: document,
      })!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      // The session opened for A now runs a turn for B.
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), host.resolveAttachmentPath(document)!);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 client file system under restrictive policies", () => {
  it.effect("serves reads through a workspace symlink and leaves writes to native diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const policies = [
        {
          name: "read-only sandbox",
          policy: {
            runtimeMode: "full-access",
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        { name: "approval-required", policy: { runtimeMode: "approval-required" } },
      ] as const;
      for (const { name, policy } of policies) {
        let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
        let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
        const instanceId = ProviderInstanceId.make(`antigravity-restrictive-${policy.runtimeMode}`);
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleReadTextFile: (handler) =>
                  Effect.sync(() => {
                    readTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
                handleWriteTextFile: (handler) =>
                  Effect.sync(() => {
                    writeTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.succeed(undefined),
        });
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-restrictive-",
        });
        const workspace = path.join(directory, "linked");
        const realWorkspace = path.join(directory, "actual");
        yield* fileSystem.makeDirectory(realWorkspace);
        yield* fileSystem.symlink(realWorkspace, workspace);
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-restrictive-outside-",
        });
        yield* fileSystem.writeFileString(path.join(workspace, "existing.ts"), "existing");
        const threadId = ThreadId.make(`thread-antigravity-restrictive-${policy.runtimeMode}`);
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            `provider-session-antigravity-restrictive-${policy.runtimeMode}`,
          ),
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
        assert.isUndefined(writeTextFile);
        if (readTextFile === undefined) {
          return yield* Effect.die("Antigravity sessions must serve client file requests");
        }
        const context = (method: string) => ({ requestId: `test-${method}`, method });
        const read = yield* readTextFile(
          { sessionId: "mock-session-1", path: path.join(workspace, "existing.ts") },
          context("fs/read_text_file"),
        );
        assert.equal(read.content, "existing", name);
        const outsideRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: path.join(outside, "x.ts") },
          context("fs/read_text_file"),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(outsideRead), name);
      }
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const telemetry = {
        html: `<ul>${rows.join("").replaceAll("tr", "li")}</ul>`,
        title: "Telemetry",
        height: 411,
      };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  // agy 1.5.8 titles the call with its MCP name and completes without any output.
                  yield* send({
                    sessionUpdate: "tool_call",
                    toolCallId: "agy-1.5.8",
                    title: "Run mcp_t3-code_html_render",
                    kind: "other",
                    status: "in_progress",
                    rawInput: { ...telemetry, toolSummary: "Render telemetry" },
                  });
                  yield* mcpSessions.recordHtmlRender(threadId, telemetry, page("agy-1.5.8"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "agy-1.5.8",
                    status: "completed",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry", "agy-1.5.8"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, telemetry), undefined);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

/**
 * A session whose prompt reports one running command and returns end_turn, as agy 1.5.11 does
 * for `run_command` once `WaitMsBeforeAsync` passes. The test sends every later frame.
 */
const openSessionWithRunningCommand = Effect.fn("openSessionWithRunningCommand")(function* (
  commandInput: Record<string, unknown>,
  tool: { readonly kind: "execute" | "other"; readonly title: string } = {
    kind: "execute",
    title: "node fetch_throughput.mjs",
  },
  /** agy 1.5 answers a steered prompt once the next one arrives, which runs to `releaseSteer`. */
  steering?: {
    readonly agentVersion: string;
    readonly holdsFirstPrompt: boolean;
    readonly failSteerBeforeDispatch?: boolean;
    readonly wakeSteerOnWire?: boolean;
    readonly cancelUpdates?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
  },
  childWorkDirectory?: string,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let wire: RuntimeService | undefined;
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("the adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));
  const command = {
    toolCallId: "call_fetch",
    ...tool,
    rawInput: tool.kind === "execute" ? { CommandLine: tool.title, ...commandInput } : commandInput,
  } as const;
  let cancels = 0;
  const prompts: Array<{
    readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
    readonly released: Deferred.Deferred<void> | undefined;
  }> = [];
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  let terminate: AcpAdapterV2RuntimeInput["onTermination"] | undefined;
  const usage = { sessionUpdate: "usage_update", used: 9000, size: 1048576 } as const;
  const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
  const firstOffer =
    yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
  const instanceId = ProviderInstanceId.make("antigravity-wake-test");
  const threadId = ThreadId.make("thread-antigravity-wake");
  const reportedCommands = yield* Queue.unbounded<{
    readonly names: ReadonlyArray<string>;
    readonly cwd: string;
  }>();
  const adapter = yield* makeAntigravityAdapterV2({
    instanceId,
    selfInvocation: yield* resolveSelfInvocation(),
    continuationRequests: {
      offer: (request) =>
        Effect.sync(() => void offers.push(request)).pipe(
          Effect.andThen(Deferred.succeed(firstOffer, request)),
          Effect.asVoid,
        ),
    },
    onSessionEvent: (event, cwd) =>
      event._tag === "AvailableCommandsUpdated"
        ? Queue.offer(reportedCommands, {
            names: event.availableCommands.map((entry) => entry.name),
            cwd,
          }).pipe(Effect.asVoid)
        : Effect.void,
    makeRuntime: (input) => {
      terminate = input.onTermination;
      return makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: {
            T3_ACP_ANTIGRAVITY: "1",
            ...(steering === undefined ? {} : { T3_ACP_AGENT_VERSION: steering.agentVersion }),
            ...(steering?.wakeSteerOnWire ? { T3_ACP_ANTIGRAVITY_WAKE_STEER: "1" } : {}),
          },
        },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.tap((runtime) =>
          Effect.sync(() => {
            wire = runtime;
          }),
        ),
        Effect.map((runtime): RuntimeService => ({
          ...runtime,
          cancel: Effect.gen(function* () {
            cancels += 1;
            if (steering?.cancelUpdates !== undefined) {
              yield* Effect.forEach(steering.cancelUpdates, send, { discard: true });
              yield* Deferred.succeed(steered, undefined);
            }
            if (steering?.wakeSteerOnWire) yield* runtime.cancel;
          }),
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              prompts.push({ prompt: payload.prompt, released: promptOptions?.released });
              if (steering?.wakeSteerOnWire) return yield* runtime.prompt(payload, promptOptions);
              if (prompts.length > 1 && steering?.failSteerBeforeDispatch === true) {
                return yield* new EffectAcpErrors.AcpTransportError({
                  detail: "ACP process exited before prompt dispatch",
                  cause: "exit",
                });
              }
              if (promptOptions?.dispatched !== undefined) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              if (prompts.length > 1) {
                yield* Deferred.succeed(steered, undefined);
                yield* Deferred.await(releaseSteer);
                return { stopReason: "end_turn" as const };
              }
              yield* send(
                childWorkDirectory === undefined
                  ? { sessionUpdate: "tool_call", ...command, status: "in_progress" }
                  : {
                      sessionUpdate: "tool_call",
                      toolCallId: "call_research",
                      kind: "other",
                      title: "Run invoke_subagent",
                      status: "completed",
                      rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Read it" },
                    },
              );
              yield* send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "I'll render once the fetch finishes." },
              });
              yield* send(usage);
              if (steering?.holdsFirstPrompt === true) yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }),
        })),
      );
    },
    withProcess: (_stop, task) => task,
    defaultModel: Effect.undefined,
    ...(childWorkDirectory === undefined ? {} : { childWorkDirectories: [childWorkDirectory] }),
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const streamEnded = yield* Deferred.make<void>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.exit,
    Effect.andThen(Deferred.succeed(streamEnded, undefined)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const startTurn = (ordinal: number, continuation: boolean) =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-antigravity-wake"),
        title: "Antigravity wake",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-antigravity-wake-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-antigravity-wake-${ordinal}`),
      rootNodeId: NodeId.make(`node-antigravity-wake-${ordinal}`),
      providerThread,
      message: {
        ...(continuation
          ? { createdBy: "agent" as const, creationSource: "provider" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        messageId: MessageId.make(`message-antigravity-wake-${ordinal}`),
        text: "chart the throughput",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    command,
    usage,
    offers,
    awaitOffer: Deferred.await(firstOffer),
    mockRequest: (method: string, payload: unknown = {}) =>
      wire === undefined
        ? Effect.die("the mock runtime must be opened")
        : wire.request(method, payload),
    drainEvents: Queue.clear(events),
    send,
    startTurn,
    until,
    throughTerminal: until((event) => event.type === "turn.terminal"),
    // The reply before end_turn closes when the prompt settles, held open or not.
    throughPromptSettled: until(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.status === "completed",
    ),
    requestPermission: (...args: Parameters<NonNullable<typeof requestPermission>>) =>
      requestPermission === undefined
        ? Effect.die("the adapter must handle permission requests")
        : requestPermission(...args),
    cancels: () => cancels,
    reportedCommands,
    prompts,
    releaseSteer: Deferred.succeed(releaseSteer, undefined),
    /** Every event the session sent before its stream ended. */
    restAfterStreamEnds: Deferred.await(streamEnded).pipe(Effect.andThen(Queue.clear(events))),
    runtimeDies: Effect.suspend(
      () =>
        terminate?.(
          new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
        ) ?? Effect.die("the adapter must watch its runtime"),
    ),
  };
});

describe("AntigravityAdapterV2 work after the prompt ends", () => {
  it.effect.each([false, true])(
    "keeps an invoke_subagent running until it reports (reported during prompt: %s)",
    (duringPrompt) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-antigravity-subagents-",
        });
        const write = (id: string, kind: string, name: string, value: unknown) =>
          Effect.gen(function* () {
            const directory = path.join(dataDirectory, "brain", id, ".system_generated", kind);
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(path.join(directory, name), JSON.stringify(value));
          });
        yield* write("mock-session-1", "subagents", "child-1.json", {});
        yield* write("child-1", "messages", "launch.json", {
          sender: "mock-session-1",
          sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
        });
        const report = write("mock-session-1", "messages", "report.json", { sender: "child-1" });
        if (duringPrompt) yield* report;
        const { usage, offers, send, startTurn, throughPromptSettled, throughTerminal } =
          yield* openSessionWithRunningCommand({}, undefined, undefined, dataDirectory);
        yield* startTurn(1, false);
        const statuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          events.flatMap((event) =>
            event.type === "subagent.updated" ? [event.subagent.status] : [],
          );
        const prompt = yield* throughPromptSettled;
        assert.equal(statuses(prompt).at(-1), duringPrompt ? "idle" : "running");
        if (!duringPrompt) {
          yield* report;
          yield* send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The researcher found it." },
          });
          yield* send(usage);
          yield* TestClock.adjust("3 seconds");
        }
        const run = yield* throughTerminal;
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.equal(statuses([...prompt, ...run]).at(-1), "idle");
        assert.lengthOf(offers, 0);
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect("projects update_steps calls as a task list", () =>
    Effect.gen(function* () {
      const { send, startTurn, command, usage, throughPromptSettled, throughTerminal } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "steps-1",
        title: "Run update_steps",
        kind: "other",
        status: "in_progress",
      });
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: "steps-1",
        rawInput: {
          steps: [
            { title: "First", status: "done" },
            { title: "Second", status: "in_progress" },
          ],
        },
      });
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: "steps-1",
        status: "completed",
      });
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Done", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done" },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const events = yield* throughTerminal;
      const plan = events.findLast((event) => event.type === "plan.updated");
      if (plan?.plan.kind !== "todo_list") return assert.fail("Expected a task list");
      assert.deepEqual(
        plan.plan.steps.map((step) => [step.text, step.status]),
        [
          ["First", "completed"],
          ["Second", "running"],
        ],
      );
      const checklist = events.findLast(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "todo_list",
      );
      assert.isTrue(
        checklist?.type === "turn_item.updated" && checklist.turnItem.status === "completed",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "steps-1",
        ),
      );
    }).pipe(Effect.provide(layerSession)),
  );

  function pendingWork(events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
    const items = new Map(
      events.flatMap((event) =>
        event.type === "turn_item.updated" ? [[event.turnItem.id, event.turnItem] as const] : [],
      ),
    );
    return derivePendingBackgroundWork({
      latestRun: { id: RunId.make("run-antigravity-wake-1"), ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [...items.values()],
    });
  }

  it.effect.each(["completed", "failed", "Stop"] as const)(
    "clears a command started after the turn settled on %s",
    (ending) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({}, { kind: "other", title: "Setup" });
        yield* opened.startTurn(1, false);
        const root = yield* opened.throughTerminal;
        assert.deepEqual(pendingWork(root), []);
        const turn = root.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");

        const toolCallId = "call_detached";
        yield* opened.send({
          sessionUpdate: "tool_call",
          toolCallId,
          kind: "execute",
          title: "Run benchmark",
          rawInput: { CommandLine: "bench --samples 20" },
          status: "pending",
        });
        yield* opened.send({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        });
        const started = yield* opened.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.sessionScoped === true &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        const pending = pendingWork([...root, ...started]);
        assert.deepEqual(pending, [
          {
            taskId: toolCallId,
            description: "bench --samples 20",
            kind: "command",
            wakesAgent: true,
          },
        ]);
        assert.isTrue(backgroundWorkHoldsCompletion(pending));
        assert.lengthOf(opened.offers, 0);

        if (ending === "completed") {
          yield* opened.send({
            sessionUpdate: "tool_call",
            toolCallId: "call_other",
            kind: "execute",
            title: "Check benchmark setup",
            status: "completed",
          });
          assert.lengthOf(opened.offers, 1, "another result can still wake the agent");
        }
        if (ending === "Stop") {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            requestRuntimeRestart: true,
          });
          // A late native response after cancellation cannot reopen anything.
          yield* opened.send({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
          });
          assert.equal(opened.cancels(), 1);
          assert.lengthOf(opened.offers, 0);
        } else {
          yield* opened.send({ sessionUpdate: "tool_call_update", toolCallId, status: ending });
          assert.lengthOf(opened.offers, 1);
        }
        const finished = yield* opened.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.sessionScoped === true &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        assert.deepInclude(finished.at(-1), {
          type: "turn_item.updated",
          sessionScoped: true,
        });
        const terminal = finished.at(-1);
        assert.equal(
          terminal?.type === "turn_item.updated" && terminal.turnItem.status,
          ending === "Stop" ? "interrupted" : ending,
        );
        assert.deepEqual(pendingWork([...root, ...started, ...finished]), []);
      }).pipe(Effect.provide(layerSession)),
  );

  // agy 1.5 reads a prompt sent mid-turn as a steer: it answers the running prompt end_turn and
  // goes on under the new one. session/cancel would end its running commands and subagents.
  it.effect("steers a running prompt with the next one and leaves its work running", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.13",
        holdsFirstPrompt: true,
      });
      const { session, providerThread, command, usage, send, startTurn, until } = opened;
      assert.isTrue(session.providerSession.capabilities.turns.supportsActiveSteering);
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      // agy 1.5.13 acknowledges invoke_subagent at once; the subagent runs on by itself.
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_artist",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { Role: "Artist", Prompt: "Paint the scooter" },
      });

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Use opus subagents from now on",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [
        { type: "text", text: "Use opus subagents from now on" },
      ]);
      assert.isTrue(
        yield* Deferred.isDone(opened.prompts[0]!.released!),
        "the steered prompt frees the runtime for the steer",
      );
      // The steered prompt has answered end_turn; the turn must outlast the finalize debounce.
      yield* TestClock.adjust("10 seconds");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Switching to opus subagents." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      const run = [...started, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Switching to opus subagents.");
      const finished = run.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // The prompt already returned and a backgrounded command holds the run open.
  it.effect("steers a run held open by a backgrounded command without stopping it", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 }, undefined, {
        agentVersion: "1.5.13",
        holdsFirstPrompt: false,
      });
      const { session, providerThread, command, usage, send, startTurn, until } = opened;
      yield* startTurn(1, false);
      const prompt = yield* opened.throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* TestClock.adjust("10 minutes");

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Also check the footnotes",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the running command");
      assert.lengthOf(opened.prompts, 2);
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll have the footnotes checked too." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      // The steer's reply is in; the command still holds the run.
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The fetch finished." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = [...prompt, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminals = run.filter((event) => event.type === "turn.terminal");
      assert.lengthOf(terminals, 1, "the steer and the command end in one run");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "I'll have the footnotes checked too.");
      assert.include(JSON.stringify(run), "The fetch finished.");
      assert.lengthOf(opened.offers, 0, "nothing ran after the run");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("hands a prompt-steer back as unsupported when the turn already ended", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.13",
        holdsFirstPrompt: false,
      });
      const { session, providerThread } = opened;
      const error = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread,
          providerTurnId: ProviderTurnId.make("provider-turn:ended"),
          message: {
            messageId: MessageId.make("message-antigravity-steer-ended"),
            text: "Try this next",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([false, true])(
    "dispatches a steer while a promptless wake reply streams (background work=%s)",
    (hasBackgroundWork) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({}, undefined, {
          agentVersion: "1.5.14",
          holdsFirstPrompt: false,
          wakeSteerOnWire: true,
        });
        const { session, providerThread, startTurn, until, mockRequest } = opened;
        const assistantItem = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? event.turnItem
            : undefined;
        const toolCallId = "call_second_command";
        const notify = (update: EffectAcpSchema.SessionUpdate) =>
          mockRequest("_test/emit-update", { sessionId: "mock-session-1", update });
        const updateBackground = (status: "in_progress" | "completed") =>
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId,
            kind: "execute",
            title: "Second background command",
            status,
            rawInput: { CommandLine: "echo benchmark", WaitMsBeforeAsync: 10_000 },
          });
        const backgroundItem = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === toolCallId
            ? event.turnItem
            : undefined;
        yield* startTurn(1, false);
        yield* opened.throughTerminal;
        yield* mockRequest("_test/complete-antigravity-command");
        const offer = yield* opened.awaitOffer;
        yield* offer.dispatchIfCurrent!(Effect.void);
        yield* startTurn(2, true);
        if (hasBackgroundWork) {
          yield* updateBackground("in_progress");
          yield* until((event) => backgroundItem(event)?.status === "running");
        }
        yield* notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "WAKE_BEGIN " },
        });
        const wake = yield* until(
          (event) => assistantItem(event)?.text.includes("WAKE_BEGIN") === true,
        );
        const wakeFirstItem = assistantItem(wake.at(-1)!)!;
        const providerTurnId = wakeFirstItem.providerTurnId!;
        const runId = RunId.make("run-antigravity-wake-2");
        assert.equal(wakeFirstItem.runId, runId);
        assert.lengthOf(opened.prompts, 1, "the wake attaches without opening a prompt");

        yield* session.steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId,
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-wake-steer"),
            text: "Reply to the new prompt",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        assert.lengthOf(opened.prompts, 2, "the new prompt went out before the wake ended");
        assert.equal(opened.cancels(), 0);

        yield* mockRequest("_test/finish-antigravity-wake");
        const replies = yield* until((event) => assistantItem(event)?.text === "STEERED");
        const wakeFinished = replies.find((event) => {
          const item = assistantItem(event);
          return item?.text === "WAKE_BEGIN WAKE_END" && item.status === "completed";
        });
        assert.isDefined(wakeFinished);
        assert.equal(assistantItem(wakeFinished!)!.id, wakeFirstItem.id);
        const steered = assistantItem(replies.at(-1)!)!;
        assert.equal(steered.runId, runId);
        assert.equal(steered.providerTurnId, providerTurnId);
        assert.notEqual(steered.id, wakeFirstItem.id);
        yield* TestClock.adjust("3 minutes");
        const beforeResponse = [...replies, ...(yield* opened.drainEvents)];
        assert.isFalse(beforeResponse.some((event) => event.type === "turn.terminal"));

        yield* mockRequest("_test/finish-antigravity-steer");
        if (hasBackgroundWork) {
          const afterResponse = yield* until((event) => {
            const item = assistantItem(event);
            return item?.id === steered.id && item.status === "completed";
          });
          yield* TestClock.adjust("3 seconds");
          assert.isFalse(
            [...afterResponse, ...(yield* opened.drainEvents)].some(
              (event) => event.type === "turn.terminal",
            ),
          );
          yield* updateBackground("completed");
          yield* until((event) => backgroundItem(event)?.status === "completed");
          yield* notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The second command finished." },
          });
          yield* notify({ ...opened.usage, used: 12_345 });
          yield* until(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.contextUsage?.usedTokens === 12_345,
          );
          yield* TestClock.adjust("3 seconds");
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.deepInclude(terminal, {
          type: "turn.terminal",
          status: "completed",
          providerTurnId,
        });
        assert.equal(opened.cancels(), 0);
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect("fails a prompt-steer promptly when prompt dispatch fails", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.13",
        holdsFirstPrompt: true,
        failSteerBeforeDispatch: true,
      });
      const { session, providerThread, command, startTurn, until } = opened;
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      const steerFiber = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer-fail"),
            text: "Change approach",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.repeat(Effect.yieldNow, { times: 40 });
      const settled = steerFiber.pollUnsafe();
      assert.isDefined(settled, "steerTurn must not hang when prompt dispatch fails");
      if (settled !== undefined) {
        assert.isTrue(Exit.isSuccess(settled) && Exit.isFailure(settled.value));
      }
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps interrupt-and-restart steering on runtimes older than 1.5", () =>
    Effect.gen(function* () {
      const { session } = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.4.12",
        holdsFirstPrompt: false,
      });
      assert.isFalse(session.providerSession.capabilities.turns.supportsActiveSteering);
    }).pipe(Effect.provide(layerSession)),
  );

  // agy's own `schedule` tool stays in progress until its timer fires (measured on agy 1.5.13),
  // then the agent wakes and replies with no prompt open.
  it.effect("keeps the session for a native schedule timer and continues when it fires", () =>
    Effect.gen(function* () {
      const { session, command, usage, offers, send, startTurn, throughTerminal } =
        yield* openSessionWithRunningCommand(
          { DurationSeconds: 3600, Prompt: "An hour has passed. Check the deploy." },
          { kind: "other", title: "Run schedule" },
        );
      yield* startTurn(1, false);
      const promptEvents = yield* throughTerminal;
      const promptTerminal = promptEvents.at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");
      const timer = promptEvents.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(timer?.type === "turn_item.updated" && timer.turnItem.status, "running");
      assert.isTrue(
        yield* session.hasPendingBackgroundWork!,
        "a pending timer must keep the agent process",
      );

      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: command.toolCallId,
        status: "completed",
      });
      assert.lengthOf(offers, 1, "the timer must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The deploy finished." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const doneTimer = continued.find(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.isTrue(
        doneTimer?.type === "turn_item.updated" && doneTimer.turnItem.status === "completed",
      );
      assert.equal(
        doneTimer?.type === "turn_item.updated" && doneTimer.turnItem.runId,
        RunId.make("run-antigravity-wake-1"),
      );
      assert.isFalse(yield* session.hasPendingBackgroundWork!);
      assert.lengthOf(offers, 1, "one timer is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // The composer reads a workspace's own command list before the account-wide one.
  it.effect("reports a thread session's native commands with its workspace", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({});
      assert.deepEqual(yield* Queue.take(opened.reportedCommands), {
        names: ["plan", "logout"],
        cwd: process.cwd(),
      });
    }).pipe(Effect.provide(layerSession)),
  );

  // The timer lives in the agy process, so it never fires once the process is gone.
  it.effect("ends a pending schedule timer's card when the agent exits", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { DurationSeconds: 3600, Prompt: "An hour has passed. Check the deploy." },
        { kind: "other", title: "Run schedule" },
      );
      yield* opened.startTurn(1, false);
      yield* opened.throughTerminal;
      assert.isTrue(yield* opened.session.hasPendingBackgroundWork!);

      yield* opened.runtimeDies;
      const card = (yield* opened.restAfterStreamEnds).findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === opened.command.toolCallId,
      );
      assert.equal(card?.type === "turn_item.updated" && card.turnItem.status, "failed");
      assert.equal(
        card?.type === "turn_item.updated" && card.turnItem.runId,
        RunId.make("run-antigravity-wake-1"),
      );
      assert.isFalse(yield* opened.session.hasPendingBackgroundWork!);
      assert.lengthOf(opened.offers, 0, "a dead timer wakes nothing");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("stops a native timer that outlived an older prompt", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { DurationSeconds: 1800, Prompt: "Check progress" },
        { kind: "other", title: "Run schedule" },
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
      );
      yield* opened.startTurn(1, false);
      const initial = yield* opened.throughTerminal;
      const turn = initial.find((event) => event.type === "provider_turn.updated");
      if (turn === undefined) return assert.fail("Expected a native provider turn");
      yield* opened.session.interruptTurn({
        providerThread: opened.providerThread,
        providerTurnId: turn.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const stopped = yield* opened.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === opened.command.toolCallId &&
          event.turnItem.status === "interrupted",
      );
      assert.include(stopped.at(-1), { sessionScoped: true });
      assert.equal(opened.cancels(), 1);
      assert.isFalse(yield* opened.session.hasPendingBackgroundWork!);
      yield* opened.send({
        sessionUpdate: "tool_call_update",
        toolCallId: opened.command.toolCallId,
        status: "completed",
      });
      assert.lengthOf(opened.offers, 0);
    }).pipe(Effect.provide(layerSession)),
  );

  // agy sets `IsDaemon` on a command it does not wait for. When it exits, the agent replies
  // with no prompt open.
  it.effect("continues in one run when a finished daemon wakes the agent", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, throughTerminal, requestPermission, until } =
        yield* openSessionWithRunningCommand({ IsDaemon: true, WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      const prompt = yield* throughTerminal;
      const promptTerminal = prompt.at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");
      assert.deepEqual(pendingWork(prompt), [
        {
          taskId: command.toolCallId,
          description: command.title,
          kind: "command",
          wakesAgent: true,
        },
      ]);

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      const finishedBeforeWake = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId &&
          event.turnItem.status === "completed",
      );
      assert.deepEqual(pendingWork([...prompt, ...finishedBeforeWake]), []);
      // The agent can ask before the app has started the continuation run.
      const followUp = { toolCallId: "call_analyze", kind: "execute", title: "node analyze.mjs" };
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { ...followUp, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { requestId: "permission-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      assert.deepEqual(yield* Fiber.join(permission), {
        outcome: { outcome: "selected", optionId: "allow" },
      });

      // The model took 6.7 s to answer the finished command; the run must outlast that silence.
      yield* TestClock.adjust("10 seconds");
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "completed" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const finished = continued.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      assert.lengthOf(offers, 1, "one wake is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // Frames as agy 1.5.11 sent them for `run_command` with `WaitMsBeforeAsync`: the prompt returns
  // end_turn while the command runs, and the agent replies when the command finishes.
  it.effect("keeps the run open while a command the agent waits for still runs", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Here is the chart.", "the reply is part of the run");
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // Live on agy 1.5.13 (thread sshcode-daily-health, 2026-11-20): the agent said it was waiting
  // for the command, the command finished, and agy woke the agent with its output. agy reports
  // usage after every model step; the wake's first step was thinking plus a tool call, so the
  // agent was still at work when that usage arrived and went quiet while the tool ran.
  it.effect("keeps a held run open while the agent works on a finished command's output", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Waiting for the test run." },
      });
      yield* send(usage);
      yield* TestClock.adjust("1 minute");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Tests passed.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "The run passed; fix the next file." },
      });
      yield* send(usage);
      yield* TestClock.adjust("30 seconds");
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_edit",
        kind: "edit",
        title: "Edit ProjectionStore.ts",
        status: "completed",
      });
      yield* send(usage);
      yield* TestClock.adjust("20 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Fixed and verified." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.isTrue(
        run.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "call_edit" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-1"),
        ),
        "the agent's follow-up work belongs to the held run",
      );
      assert.include(JSON.stringify(run), "Fixed and verified.");
      assert.lengthOf(offers, 0, "the held run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // agy can end a step with text and then take another by itself, 4 to 6 seconds later on
  // 2026-11-21. A run that ends on such a quiet spell says another may follow.
  it.effect("says the agent may continue a held run that ends on a quiet spell", () =>
    Effect.gen(function* () {
      const { command, usage, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Tests passed.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Finalizing the second commit." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const terminal = (yield* until((event) => event.type === "turn.terminal")).at(-1);
      assert.deepInclude(terminal, {
        type: "turn.terminal",
        status: "completed",
        continuationExpected: true,
      });
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([
    // session/cancel ends the agent's commands, so only Stop may send it.
    { ending: "Stop", cancels: 1, status: "interrupted" },
    { ending: "a new message", cancels: 0, status: "interrupted" },
    { ending: "the agent exiting", cancels: 0, status: "failed" },
  ] as const)(
    "ends a run held open by a running command on $ending",
    ({ ending, cancels, status }) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
        yield* opened.startTurn(1, false);
        const started = yield* opened.throughPromptSettled;
        const turn = started.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");
        if (ending === "the agent exiting") {
          yield* opened.runtimeDies;
        } else {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            ...(ending === "Stop" ? { requestRuntimeRestart: true } : {}),
          });
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, status);
        assert.equal(opened.cancels(), cancels);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("Antigravity question options", () => {
  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });
});

describe("AntigravityAdapterV2 subagent reads", () => {
  it.effect("completes a read T3 served when the agent later fails it with a step error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-outside-",
      });
      const served = path.join(workspace, "served.ts");
      yield* fileSystem.writeFileString(served, "export {};");
      const denied = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(denied, "secret");
      const unseen = path.join(workspace, "unseen.ts");
      const retried = path.join(workspace, "retried.ts");
      const stepError = 'Model produced invalid output. ("model output error")';
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-subagent-reads-test");
      const threadId = ThreadId.make("thread-antigravity-subagent-reads");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              // agy_acp_server announces a subagent's client_view_file on the parent session,
              // never completes it, then fails every open call with the next step error.
              prompt: () =>
                Effect.gen(function* () {
                  if (sessionUpdate === undefined || readTextFile === undefined) {
                    return yield* Effect.die("the adapter must handle updates and reads");
                  }
                  const send = sessionUpdate;
                  const handleRead = readTextFile;
                  const update = (update: EffectAcpSchema.SessionUpdate) =>
                    send(
                      normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                    );
                  // The agent's own view_file never reaches T3, so it must not take a served read.
                  const reads = [
                    ["call_native", served, "Running view_file"],
                    ["call_served", served, "Running client_view_file"],
                    ["call_missing", retried, "Running client_view_file"],
                    ["call_retried", retried, "Running client_view_file"],
                    ["call_denied", denied, "Running client_view_file"],
                    ["call_unseen", unseen, "Running client_view_file"],
                  ] as const;
                  for (const [toolCallId, target, title] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title,
                      kind: "read",
                      status: "in_progress",
                      rawInput: { absolute_path: target },
                      locations: [{ path: target }],
                    });
                  }
                  const serve = (target: string) =>
                    handleRead(
                      { sessionId: "subagent-conversation", path: target },
                      { requestId: `read-${target}`, method: "fs/read_text_file" },
                    ).pipe(Effect.exit);
                  yield* serve(served);
                  yield* serve(retried);
                  yield* fileSystem.writeFileString(retried, "export {};").pipe(Effect.orDie);
                  yield* serve(retried);
                  yield* serve(denied);
                  for (const [toolCallId] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: stepError,
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        defaultModel: Effect.succeed(undefined),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-subagent-reads"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-subagent-reads"),
          title: "Antigravity subagent reads",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-subagent-reads"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-subagent-reads"),
        rootNodeId: NodeId.make("node-antigravity-subagent-reads"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-subagent-reads"),
          text: "review the codebase",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const read = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? { status: event.turnItem.status, output: event.turnItem.output }
          : undefined;
      };

      const firstEvent = (nativeId: string, status: string) =>
        events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId &&
            event.turnItem.status === status,
        );
      // T3 completes a served read itself instead of leaving it running until the flush.
      assert.isAbove(firstEvent("call_served", "completed"), -1);
      assert.isBelow(firstEvent("call_served", "completed"), firstEvent("call_native", "failed"));
      const failed = { status: "failed" as const, output: stepError };
      assert.deepEqual(read("call_served"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_retried"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_native"), failed);
      assert.deepEqual(read("call_missing"), failed);
      assert.deepEqual(read("call_denied"), failed);
      assert.deepEqual(read("call_unseen"), failed);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        defaultModel: Effect.succeed(undefined),
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 compaction", () => {
  // agy 1.5.13 advertises `/compact`; older runtimes treated it as ordinary model input.
  it.effect.each([true, false])(
    "compacts only when the session advertises /compact (%s)",
    (advertised) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-compact-" });
        const requestLog = path.join(logs, "requests.ndjson");
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AVAILABLE_COMMANDS: advertised ? "compact" : "",
                  T3_ACP_COMPACTION_PROMPT_ORDINALS: "1",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                },
              },
            }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
          withProcess: (_stop, task) => task,
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          defaultModel: Effect.succeed(undefined),
        });
        const threadId = ThreadId.make("thread-antigravity-compaction");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
          modelSelection,
          runtimePolicy,
        });
        const compactThread = session.compactThread;
        assert.isDefined(compactThread);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
        });
        if (advertised) {
          yield* compactThread!(turnInput);
          const events = yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "compaction" &&
                event.turnItem.status === "completed",
            ),
          );
        } else {
          const error = yield* compactThread!(turnInput).pipe(Effect.flip);
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(error.cause, ProviderAdapter.ProviderCompactionUnsupportedError);
        }
        const prompts = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params?.prompt);
        assert.deepEqual(prompts, advertised ? [[{ type: "text", text: "/compact" }]] : []);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 quota stops", () => {
  const ultraNotice =
    "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h33m33s.\n";
  const chunk = (text: string): EffectAcpSchema.SessionUpdate => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
  const read: EffectAcpSchema.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "call_read",
    title: "Read package.json",
    kind: "read",
    status: "completed",
  };
  const usage: EffectAcpSchema.SessionUpdate = {
    sessionUpdate: "usage_update",
    used: 9000,
    size: 1048576,
  };

  /** One turn whose prompt streams `updates`, then ends on `stopReason`. */
  const runTurn = Effect.fn("runAntigravityQuotaTurn")(function* (
    updates: ReadonlyArray<EffectAcpSchema.SessionUpdate>,
    stopReason: "end_turn" | "refusal" = "end_turn",
  ) {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
    const instanceId = ProviderInstanceId.make("antigravity-quota-test");
    const threadId = ThreadId.make("thread-antigravity-quota");
    const adapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (input) =>
        makeAntigravityAcpRuntime({
          ...input,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: input.cwd,
            env: { T3_ACP_ANTIGRAVITY: "1" },
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime): RuntimeService => ({
            ...runtime,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdate = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            prompt: (_payload, promptOptions) =>
              Effect.gen(function* () {
                if (promptOptions?.dispatched !== undefined) {
                  yield* Deferred.succeed(promptOptions.dispatched, undefined);
                }
                for (const update of updates) {
                  if (sessionUpdate === undefined) {
                    return yield* Effect.die("the adapter must handle session updates");
                  }
                  yield* sessionUpdate(
                    normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                  );
                }
                return { stopReason };
              }),
          })),
        ),
      withProcess: (_stop, task) => task,
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
      defaultModel: Effect.succeed(undefined),
    });
    const modelSelection = { instanceId, model: "gemini-test-low" } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-antigravity-quota"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    // The test clock stands still, so this is also when the prompt ends.
    const now = yield* DateTime.now;
    yield* session.startTurn(
      makeTurnInput({ threadId, providerThread, instanceId, modelSelection, runtimePolicy, now }),
    );
    const events = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const terminal = events.at(-1);
    if (terminal?.type !== "turn.terminal") return yield* Effect.die("the turn must end");
    return { terminal, now };
  });

  it.effect.each([
    // The managed runtime ends the prompt on `refusal` after its own notice. It rounds the
    // wait down, so the reset is the end of its last minute.
    {
      name: "the managed runtime's refusal",
      text: "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 hours, 33 minutes.",
      stopReason: "refusal",
      wait: { hours: 4, minutes: 34 },
    },
    // The agy CLI passes on Google's notice as the reply and ends the prompt on `end_turn`.
    {
      name: "the CLI's Ultra notice",
      text: ultraNotice,
      stopReason: "end_turn",
      wait: { hours: 4, minutes: 33, seconds: 33 },
    },
    {
      name: "the CLI's Pro notice",
      text: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h24m31s.\nError ID: 4deb0bab-0266-4e73-b09c-9832e171ca9a-339",
      stopReason: "end_turn",
      wait: { hours: 1, minutes: 24, seconds: 31 },
    },
  ] as const)(
    "fails $name as a usage limit with the reported reset time",
    ({ text, stopReason, wait }) =>
      Effect.gen(function* () {
        const { terminal, now } = yield* runTurn([read, chunk(text), usage], stopReason);
        assert.equal(terminal.status, "failed");
        assert.deepEqual(terminal.failure, {
          class: "usage_limit",
          message: text.trim(),
          code: "antigravity_quota",
          retryable: false,
          resetAt: DateTime.formatIso(DateTime.add(now, wait)),
        });
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect.each([
    {
      name: "quotes the notice in its answer",
      updates: [
        chunk(
          `Antigravity answers "${ultraNotice.trim()}" once the shared window is spent, so the run looks finished.`,
        ),
      ],
    },
    {
      name: "works on after the notice",
      updates: [chunk(ultraNotice), usage, read, chunk("Retried on Gemini; the tests pass.")],
    },
  ])("completes a turn whose agent $name", ({ updates }) =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn([...updates, usage]);
      assert.equal(terminal.status, "completed");
      assert.isNull(terminal.failure);
      // It ended on its prompt's response, so nothing more follows by itself.
      assert.notProperty(terminal, "continuationExpected");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session resume and restart", () => {
  it.effect(
    "uses session/resume instead of session/load on resumeThread and resumes directly without session/new after inactivity restart",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const activationCalls: Array<string> = [];
        const startedRequests: Array<{ readonly runtime: number; readonly method: string }> = [];
        const resumeInputs: Array<string | undefined> = [];
        let runtimeOrdinal = 0;
        const instanceId = ProviderInstanceId.make("antigravity-resume-restart-test");
        const threadId = ThreadId.make("thread-antigravity-resume-restart");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) => {
            const ordinal = ++runtimeOrdinal;
            resumeInputs.push(input.resumeSessionId);
            return makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_SESSION_LIFECYCLE: "1",
                  ...(ordinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {}),
                },
              },
              requestLogger: (event) =>
                Effect.sync(() => {
                  if (event.status === "started") {
                    startedRequests.push({ runtime: ordinal, method: event.method });
                  }
                }),
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime) => ({
                ...runtime,
                loadSession: (sessionId, activationOptions) =>
                  Effect.sync(() => {
                    activationCalls.push(`load:${sessionId}`);
                  }).pipe(Effect.andThen(runtime.loadSession(sessionId, activationOptions))),
                resumeSession: (sessionId, activationOptions) =>
                  Effect.sync(() => {
                    activationCalls.push(`resume:${sessionId}`);
                  }).pipe(Effect.andThen(runtime.resumeSession(sessionId, activationOptions))),
              })),
            );
          },
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-resume-restart"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        // 1. Switching to a different saved session on the live runtime must honor preferResumeSession.
        const otherThread: OrchestrationV2ProviderThread = {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "saved-session-2",
            strength: "strong",
          },
        };
        yield* session.resumeThread({
          providerThread: otherThread,
          modelSelection,
          runtimePolicy,
        });
        assert.deepEqual(activationCalls, ["resume:saved-session-2"]);

        // 2. After inactivity retires the runtime, the next turn must restart directly into
        // session/resume without creating a throwaway session/new first.
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread: otherThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );
        yield* TestClock.adjust("15 minutes");
        const timedOut = yield* session.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.equal(
          timedOut[0]?.type === "turn.terminal" ? timedOut[0].status : undefined,
          "failed",
        );

        yield* session.startTurn({
          ...makeTurnInput({
            threadId,
            providerThread: otherThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
          runId: RunId.make("run-antigravity-resume-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt-antigravity-resume-2"),
          rootNodeId: NodeId.make("node-antigravity-resume-2"),
        });
        const recovered = yield* session.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.equal(
          recovered[0]?.type === "turn.terminal" ? recovered[0].status : undefined,
          "completed",
        );

        assert.deepEqual(resumeInputs, [undefined, "saved-session-2"]);
        const secondRuntimeMethods = startedRequests
          .filter((entry) => entry.runtime === 2)
          .map((entry) => entry.method);
        assert.notInclude(secondRuntimeMethods, "session/new");
        assert.include(secondRuntimeMethods, "session/resume");
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 wake steer watchdog, skill dispatch, and async /compact", () => {
  it.effect("arms the inactivity watchdog when steering a promptless wake turn", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { IsDaemon: true, WaitMsBeforeAsync: 500 },
        undefined,
        { agentVersion: "1.5.14", holdsFirstPrompt: false },
      );
      const { session, providerThread, command, send, startTurn, until, throughTerminal } = opened;
      yield* startTurn(1, false);
      yield* throughTerminal;

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "done", exit_code: 0 },
      });
      const offer = yield* opened.awaitOffer;
      yield* offer.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checking output..." },
      });
      const wakeEvents = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text.includes("Checking output"),
      );
      const providerTurnId = wakeEvents.findLast(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
      );
      if (
        providerTurnId?.type !== "turn_item.updated" ||
        providerTurnId.turnItem.providerTurnId === null
      ) {
        return assert.fail("expected wake turn id");
      }

      // Steer the promptless wake turn; the fixture holds the steer prompt open silently.
      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-2"),
        providerThread,
        providerTurnId: providerTurnId.turnItem.providerTurnId,
        message: {
          messageId: MessageId.make("message-wake-steer-hang"),
          text: "Switch to the other branch",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* TestClock.adjust("15 minutes");
      const terminalFiber = yield* throughTerminal.pipe(Effect.forkChild);
      yield* Effect.repeat(Effect.yieldNow, { times: 40 });
      const settled = terminalFiber.pollUnsafe();
      assert.isDefined(settled, "watchdog must fail a silent steer on a promptless wake turn");
      const events = yield* Fiber.join(terminalFiber);
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
      assert.include(
        terminal?.type === "turn.terminal" ? terminal.failure?.message : undefined,
        "15 minutes",
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("dispatches advertised skill mentions in prompt-steer messages", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.14",
        holdsFirstPrompt: true,
      });
      const { session, providerThread, command, send, startTurn, until, prompts, releaseSteer } =
        opened;
      yield* send({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "deploy-check", description: "Check deploy" }],
        _meta: { availableSkills: ["deploy-check"] },
      });
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-steer-skill"),
          text: "Please run $deploy-check on prod",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* releaseSteer;
      assert.deepEqual(prompts[1]?.prompt, [
        { type: "text", text: "/deploy-check Please run on prod" },
      ]);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "waits briefly for asynchronous available_commands_update before rejecting /compact",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let allowCommands = false;
        const sentPrompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>> = [];
        const instanceId = ProviderInstanceId.make("antigravity-async-compact-test");
        const threadId = ThreadId.make("thread-antigravity-async-compact");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_COMPACTION_PROMPT_ORDINALS: "1",
                },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(
                    Effect.andThen(
                      runtime.handleSessionUpdate((notification) =>
                        !allowCommands &&
                        notification.update.sessionUpdate === "available_commands_update"
                          ? Effect.void
                          : handler(notification),
                      ),
                    ),
                  ),
                prompt: (payload, promptOptions) => {
                  sentPrompts.push(payload.prompt);
                  return runtime.prompt(payload, promptOptions);
                },
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-async-compact"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
        });

        const compactFiber = yield* session.compactThread!(turnInput).pipe(Effect.forkChild);
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        assert.isUndefined(
          compactFiber.pollUnsafe(),
          "compactThread must wait briefly for the initial available_commands_update",
        );
        allowCommands = true;
        yield* sessionUpdate!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "compact", description: "Compact context" }],
          },
        });
        yield* Fiber.join(compactFiber);
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        assert.deepEqual(sentPrompts, [[{ type: "text", text: "/compact" }]]);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 per-turn usage and read-repair across steer", () => {
  it.effect("captures agy per-turn PromptResponse.usage and normalizes uncached inputTokens", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-usage-test");
      const threadId = ThreadId.make("thread-antigravity-usage");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: (_payload, promptOptions) =>
                Effect.gen(function* () {
                  if (promptOptions?.dispatched !== undefined) {
                    yield* Deferred.succeed(promptOptions.dispatched, undefined);
                  }
                  yield* sessionUpdate!({
                    sessionId: "mock-session-1",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Done." },
                    },
                  });
                  return {
                    stopReason: "end_turn" as const,
                    usage: {
                      inputTokens: 4280,
                      outputTokens: 38,
                      cachedReadTokens: 13705,
                      cachedWriteTokens: 0,
                      thoughtTokens: 0,
                      totalTokens: 18023,
                    },
                  };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-usage"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const completed = events.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 17985,
          outputTokens: 38,
          cachedInputTokens: 13705,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "preserves served client_view_file read-repair state across a mid-turn prompt steer",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-steer-reads-",
        });
        const served = path.join(workspace, "served.ts");
        yield* fileSystem.writeFileString(served, "export {};");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
        const readServed = yield* Deferred.make<void>();
        const steered = yield* Deferred.make<void>();
        let promptCount = 0;
        const instanceId = ProviderInstanceId.make("antigravity-steer-reads-test");
        const threadId = ThreadId.make("thread-antigravity-steer-reads");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.14" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                handleReadTextFile: (handler) =>
                  Effect.sync(() => {
                    readTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    const ordinal = ++promptCount;
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    if (ordinal === 1) {
                      yield* sessionUpdate!(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update: {
                            sessionUpdate: "tool_call",
                            toolCallId: "call_served_before_steer",
                            title: "Running client_view_file",
                            kind: "read",
                            status: "in_progress",
                            rawInput: { absolute_path: served },
                            locations: [{ path: served }],
                          },
                        }),
                      );
                      yield* readTextFile!(
                        { sessionId: "subagent-conversation", path: served },
                        { requestId: "read-served", method: "fs/read_text_file" },
                      );
                      yield* Deferred.succeed(readServed, undefined);
                      yield* Deferred.await(steered);
                      return { stopReason: "end_turn" as const };
                    }
                    yield* Deferred.succeed(steered, undefined);
                    yield* sessionUpdate!(
                      normalizeAntigravitySessionUpdate({
                        sessionId: "mock-session-1",
                        update: {
                          sessionUpdate: "tool_call_update",
                          toolCallId: "call_served_before_steer",
                          status: "failed",
                          rawOutput: "Model produced invalid output.",
                        },
                      }),
                    );
                    yield* sessionUpdate!({
                      sessionId: "mock-session-1",
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Continued after steer." },
                      },
                    });
                    return { stopReason: "end_turn" as const };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-steer-reads"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now,
        });
        yield* session.startTurn(turnInput);
        yield* Deferred.await(readServed);
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        let providerTurnId: ProviderTurnId | undefined;
        while (providerTurnId === undefined) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "provider_turn.updated") {
            providerTurnId = event.providerTurn.id;
          }
        }
        yield* session.steerTurn({
          threadId,
          runId: turnInput.runId,
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-steer-keep-reads"),
            text: "Also check the tests",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "turn.terminal") break;
        }
        const readItem = seen.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "call_served_before_steer",
        );
        assert.equal(
          readItem?.type === "turn_item.updated" ? readItem.turnItem.status : undefined,
          "completed",
        );
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "projects diffStr and structured changes[] for both small and >8KB ACP v1 file_change updates",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "antigravity-file-change-diffs-",
        });
        const instanceId = ProviderInstanceId.make("antigravity-file-change-diffs");
        const threadId = ThreadId.make("thread-antigravity-file-change-diffs");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let onSessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}: ${"x".repeat(48)}`);
        const newLines = [...oldLines];
        newLines[4] = `line 5: EDITED ${"x".repeat(48)}`;
        const largeOld = `${oldLines.join("\n")}\n`;
        const largeNew = `${newLines.join("\n")}\n`;

        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.16" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    onSessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      onSessionUpdate?.(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update,
                        }),
                      ) ?? Effect.void;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "edit_large",
                      title: "Editing /workspace/large.txt",
                      kind: "edit",
                      status: "in_progress",
                      rawInput: { Path: "/workspace/large.txt" },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "edit_large",
                      status: "completed",
                      content: [
                        {
                          type: "diff",
                          path: "/workspace/large.txt",
                          oldText: largeOld,
                          newText: largeNew,
                        },
                      ],
                    });
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "write_small",
                      title: "Creating /workspace/created.txt",
                      kind: "edit",
                      status: "in_progress",
                      rawInput: { Path: "/workspace/created.txt" },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "write_small",
                      status: "completed",
                      content: [
                        {
                          type: "diff",
                          path: "/workspace/created.txt",
                          newText: "hello world\n",
                        },
                      ],
                    });
                    return { stopReason: "end_turn" };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-diffs"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "turn.terminal") break;
        }
        const latestItem = (nativeId: string) => {
          const event = seen.findLast(
            (candidate) =>
              candidate.type === "turn_item.updated" &&
              candidate.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" ? event.turnItem : undefined;
        };
        const largeEdit = latestItem("edit_large");
        assert.equal(largeEdit?.type, "file_change");
        if (largeEdit?.type === "file_change") {
          assert.equal(largeEdit.fileName, "/workspace/large.txt");
          assert.deepEqual(largeEdit.changes, [
            { operation: "modify", path: "/workspace/large.txt" },
          ]);
          assert.include(largeEdit.diffStr ?? "", "+line 5: EDITED");
        }
        const smallWrite = latestItem("write_small");
        assert.equal(smallWrite?.type, "file_change");
        if (smallWrite?.type === "file_change") {
          assert.equal(smallWrite.fileName, "/workspace/created.txt");
          assert.deepEqual(smallWrite.changes, [
            { operation: "add", path: "/workspace/created.txt" },
          ]);
          assert.include(smallWrite.diffStr ?? "", "+hello world");
        }
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "hydrates T3 MCP tool output (delegate_task ids and MCP isError) when agy omits rawOutput",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "antigravity-mcp-output-",
        });
        const instanceId = ProviderInstanceId.make("antigravity-mcp-output");
        const threadId = ThreadId.make("thread-antigravity-mcp-output");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let onSessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;

        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.16" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    onSessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      onSessionUpdate?.(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update,
                        }),
                      ) ?? Effect.void;
                    const delegateInput = {
                      task: "Inspect auth module",
                      title: "Auth review",
                      toolSummary: "Delegate auth review",
                    };
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "call_delegate",
                      title: "mcp_t3-code_delegate_task",
                      kind: "other",
                      status: "in_progress",
                      rawInput: delegateInput,
                      _meta: { is_mcp_tool_call: true },
                    });
                    // Server-side MCP handler executes and records the result before agy completes.
                    yield* mcpSessions.recordToolResult(threadId, "delegate_task", delegateInput, {
                      taskId: "task-abc",
                      childThreadId: "thread-child-1",
                      status: "running",
                    });
                    // agy 1.5.16 sends NO rawOutput and NO content on MCP completion.
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "call_delegate",
                      status: "completed",
                      _meta: { is_mcp_tool_call: true },
                    });
                    // A repeated completion update must retain the hydrated output.
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "call_delegate",
                      status: "completed",
                      _meta: { is_mcp_tool_call: true },
                    });

                    const failedInput = { threadId: "missing", toolSummary: "Read missing thread" };
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "call_read_err",
                      title: "mcp_t3-code_t3_thread_read",
                      kind: "other",
                      status: "in_progress",
                      rawInput: failedInput,
                      _meta: { is_mcp_tool_call: true },
                    });
                    yield* mcpSessions.recordToolResult(threadId, "t3_thread_read", failedInput, {
                      isError: true,
                      content: [{ type: "text", text: "Thread missing not found" }],
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "call_read_err",
                      status: "completed",
                      _meta: { is_mcp_tool_call: true },
                    });
                    return { stopReason: "end_turn" };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-mcp-out"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "turn.terminal") break;
        }
        const latestItem = (nativeId: string) => {
          const event = seen.findLast(
            (candidate) =>
              candidate.type === "turn_item.updated" &&
              candidate.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" ? event.turnItem : undefined;
        };
        const delegateItem = latestItem("call_delegate");
        assert.equal(delegateItem?.type, "dynamic_tool");
        if (delegateItem?.type === "dynamic_tool") {
          assert.equal(delegateItem.toolName, "t3-code.delegate_task");
          assert.deepEqual(delegateItem.output, {
            taskId: "task-abc",
            childThreadId: "thread-child-1",
            status: "running",
          });
        }
        const errItem = latestItem("call_read_err");
        assert.equal(errItem?.type, "dynamic_tool");
        if (errItem?.type === "dynamic_tool") {
          assert.equal(errItem.toolName, "t3-code.t3_thread_read");
          assert.deepEqual(errItem.output, {
            isError: true,
            content: [{ type: "text", text: "Thread missing not found" }],
          });
        }
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "records live and final providerTurn.tokenUsage, tool-wait-excluded generation rate, imagePath previews, and readable command/orchestration tool titles",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "antigravity-usage-polish-",
        });
        const instanceId = ProviderInstanceId.make("antigravity-usage-polish");
        const threadId = ThreadId.make("thread-antigravity-usage-polish");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let onSessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;

        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.16" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    onSessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      onSessionUpdate?.(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update,
                        }),
                      ) ?? Effect.void;
                    // Step 1: 1000ms of streaming thought before running a command.
                    yield* TestClock.adjust("200 millis");
                    yield* send({
                      sessionUpdate: "agent_thought_chunk",
                      content: { type: "text", text: "Planning command..." },
                    });
                    yield* TestClock.adjust("1000 millis");
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "cmd_with_summary",
                      title: "git status",
                      kind: "execute",
                      status: "in_progress",
                      rawInput: {
                        CommandLine: "git status",
                        toolSummary: "Check repository status",
                      },
                    });
                    // Tool runs for 60 seconds — must NOT drag down generation tok/s!
                    yield* TestClock.adjust("60 seconds");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "cmd_with_summary",
                      status: "completed",
                      rawOutput: { output: "clean\n", exit_code: 0 },
                    });
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "cmd_plain",
                      title: "ls -la",
                      kind: "execute",
                      status: "completed",
                      rawInput: { CommandLine: "ls -la" },
                    });
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "img_gen_1",
                      title: "generate_image",
                      kind: "other",
                      status: "completed",
                      rawOutput: {
                        imageName: "diagram",
                        imagePath: "file:///workspace/diagram.png",
                      },
                    });
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "manage_list",
                      title: "Run manage_task",
                      kind: "other",
                      status: "completed",
                      rawInput: { Action: "list" },
                    });
                    yield* send({
                      sessionUpdate: "usage_update",
                      used: 14_200,
                      size: 1_048_576,
                    });
                    // Step 2: 1000ms of streaming text reply.
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "All set." },
                    });
                    yield* TestClock.adjust("1000 millis");
                    yield* send({
                      sessionUpdate: "usage_update",
                      used: 15_000,
                      size: 1_048_576,
                    });
                    return {
                      stopReason: "end_turn",
                      usage: {
                        inputTokens: 3_000,
                        cachedReadTokens: 12_000,
                        cachedWriteTokens: 0,
                        outputTokens: 400,
                        thoughtTokens: 300,
                        totalTokens: 15_400,
                      },
                    };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-usage-polish"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "turn.terminal") break;
        }
        const turnUpdates = seen.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn] : [],
        );
        // Mid-turn live tokenUsage update from usage_update
        const runningWithUsage = turnUpdates.find(
          (turn) => turn.status === "running" && turn.tokenUsage?.usedTokens === 14_200,
        );
        assert.isDefined(runningWithUsage);
        assert.equal(runningWithUsage?.tokenUsage?.maxTokens, 1_048_576);

        // Final providerTurn has BOTH merged tokenUsage AND tool-wait-excluded generation
        const finalTurn = turnUpdates.at(-1);
        assert.equal(finalTurn?.status, "completed");
        assert.deepInclude(finalTurn?.tokenUsage, {
          usedTokens: 15_000,
          maxTokens: 1_048_576,
          inputTokens: 15_000,
          cachedInputTokens: 12_000,
          outputTokens: 400,
          reasoningOutputTokens: 300,
        });
        assert.isDefined(finalTurn?.generation);
        assert.equal(finalTurn?.generation?.basis, "decode");
        assert.equal(finalTurn?.generation?.outputTokens, 400);
        // Active decode was 2,000ms (1s thought + 1s reply), NOT 62,000ms!
        assert.equal(finalTurn?.generation?.generatingMs, 2_000);

        const latestItem = (nativeId: string) => {
          const event = seen.findLast(
            (candidate) =>
              candidate.type === "turn_item.updated" &&
              candidate.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" ? event.turnItem : undefined;
        };
        const cmdWithSummary = latestItem("cmd_with_summary");
        assert.equal(cmdWithSummary?.type, "command_execution");
        assert.equal(cmdWithSummary?.title, "Check repository status");

        const cmdPlain = latestItem("cmd_plain");
        assert.equal(cmdPlain?.type, "command_execution");
        assert.isNull(cmdPlain?.title);

        const imgGen = latestItem("img_gen_1");
        assert.equal(imgGen?.type, "dynamic_tool");
        if (imgGen?.type === "dynamic_tool") {
          assert.equal(imgGen.viewedImagePath, "/workspace/diagram.png");
        }

        const manageList = latestItem("manage_list");
        assert.equal(manageList?.type, "dynamic_tool");
        assert.equal(manageList?.title, "List background tasks");
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 agy >= 1.5.15 open-prompt background waiting", () => {
  it.effect("shows the command and timer cancelled by Stop as interrupted", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 1 }, undefined, {
        agentVersion: "1.5.16",
        holdsFirstPrompt: true,
        // agy closes its command as failed and its timer as completed before acknowledging cancel.
        cancelUpdates: [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_fetch",
            status: "failed",
            rawOutput: { combinedOutput: "Partial output" },
          },
          { sessionUpdate: "tool_call_update", toolCallId: "timer", status: "completed" },
        ],
      });
      yield* opened.startTurn(1, false);
      const started = yield* opened.throughPromptSettled;
      const turn = started.find((event) => event.type === "provider_turn.updated");
      if (turn === undefined) return assert.fail("expected a running turn");
      yield* opened.send({
        sessionUpdate: "tool_call",
        toolCallId: "timer",
        kind: "other",
        title: "Run schedule",
        rawInput: { DurationSeconds: 100, Prompt: "Check progress" },
        status: "in_progress",
      });
      yield* opened.session.interruptTurn({
        providerThread: opened.providerThread,
        providerTurnId: turn.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const events = yield* opened.throughTerminal;
      const finalTools = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.deepInclude(
        finalTools.findLast((item) => item.type === "command_execution"),
        {
          status: "interrupted",
          output: "Partial output",
        },
      );
      assert.equal(
        finalTools.findLast((item) => item.type === "dynamic_tool")?.status,
        "interrupted",
      );
      assert.deepInclude(events.at(-1), { type: "turn.terminal", status: "interrupted" });
      assert.lengthOf(opened.offers, 0);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("keeps the timer wait through native tool updates and a steer", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T05:30:52.935Z"));
      const opened = yield* openSessionWithRunningCommand(
        { DurationSeconds: 1800, Prompt: "Check progress" },
        { kind: "other", title: "Run schedule" },
        { agentVersion: "1.5.16", holdsFirstPrompt: true },
      );
      const { session, providerThread, command: timer, usage, send, startTurn, until } = opened;
      const command = {
        toolCallId: "call_rollouts",
        title: "Run command",
        kind: "execute",
        rawInput: {
          CommandLine: "run-rollouts",
          WaitMsBeforeAsync: 500,
          IsDaemon: false,
          toolSummary: "Run teacher rollouts on Modal",
        },
      } as const;
      const waitRoster = (count: number) =>
        until(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.waitingOnBackgroundWork === true &&
            event.providerThread.pendingBackgroundTasks?.length === count,
        );
      yield* startTurn(1, false);
      const started = yield* waitRoster(1);
      const waiting = started.at(-1);
      const waitStart = (event: typeof waiting) =>
        event?.type === "provider_thread.updated"
          ? event.providerThread.backgroundWaitStartedAt
          : undefined;
      assert.equal(waitStart(waiting), "2026-11-25T05:30:52.935Z");
      assert.deepEqual(
        waiting?.type === "provider_thread.updated" &&
          waiting.providerThread.pendingBackgroundTasks,
        [
          {
            taskId: timer.toolCallId,
            kind: "background_task",
            description: "Set timer",
            wakeAt: "2026-11-25T06:00:52.935Z",
          },
        ],
      );
      yield* TestClock.adjust("2 seconds");
      yield* send({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
      assert.equal(waitStart((yield* waitRoster(2)).at(-1)), waitStart(waiting));
      yield* send(usage);
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("steer-while-timer-waits"),
          text: "Check the rollouts too",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0);
      const resumed = yield* until(
        (event) =>
          event.type === "provider_thread.updated" && !event.providerThread.waitingOnBackgroundWork,
      );
      assert.isUndefined(waitStart(resumed.at(-1)));
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I will check the rollouts." },
      });
      // Native command updates after assistant text must not overwrite the reply's end signal.
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: command.toolCallId,
        status: "in_progress",
      });
      yield* TestClock.adjust("3 seconds");
      yield* send(usage);
      assert.equal(waitStart((yield* waitRoster(2)).at(-1)), "2026-11-25T05:30:57.935Z");
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: command.toolCallId,
        status: "failed",
      });
      const afterFailure = yield* waitRoster(1);
      const timerOnly = afterFailure.at(-1);
      assert.deepEqual(
        timerOnly?.type === "provider_thread.updated" &&
          timerOnly.providerThread.pendingBackgroundTasks?.map((task) => task.taskId),
        [timer.toolCallId],
      );
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: timer.toolCallId,
        status: "completed",
      });
      yield* opened.releaseSteer;
      const terminal = yield* opened.throughTerminal;
      const cleared = terminal.findLast((event) => event.type === "provider_thread.updated");
      assert.deepEqual(cleared?.providerThread.pendingBackgroundTasks, []);
      assert.isUndefined(cleared?.providerThread.backgroundWaitStartedAt);
      assert.equal(terminal.at(-1)?.type, "turn.terminal");
      assert.equal(opened.cancels(), 0);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "projects named swarm workers, waits on an open ACP prompt, and idles the workers on end_turn",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "antigravity-1516-waiting-",
        });
        const instanceId = ProviderInstanceId.make("antigravity-1516-waiting");
        const threadId = ThreadId.make("thread-antigravity-1516-waiting");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let onSessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const waitingGate = yield* Deferred.make<void>();
        const wakeGate = yield* Deferred.make<void>();
        const finishPromptGate = yield* Deferred.make<void>();

        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.17" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    onSessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      onSessionUpdate?.(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update,
                        }),
                      ) ?? Effect.void;
                    // Launch a non-daemon command and two named workers.
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "bg_bench",
                      title: "bench --full",
                      kind: "execute",
                      status: "in_progress",
                      rawInput: {
                        CommandLine: "bench --full",
                        IsDaemon: false,
                        WaitMsBeforeAsync: 500,
                        toolSummary: "Run full benchmark",
                      },
                    });
                    for (const name of ["colors", "fruits"]) {
                      yield* send({
                        sessionUpdate: "tool_call",
                        toolCallId: name,
                        title: "Running swarm",
                        kind: "other",
                        status: "in_progress",
                        rawInput: {
                          action: "add",
                          name,
                          brief: `Count distinct lines in ${name}.txt`,
                          ...(name === "colors" ? { model: "gemini-3.8-flash" } : {}),
                        },
                      });
                      yield* send({
                        sessionUpdate: "tool_call_update",
                        toolCallId: name,
                        status: "completed",
                      });
                    }
                    // Initial reply closes with usage_update while the ACP prompt stays open.
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Running benchmark and researcher." },
                    });
                    yield* send({
                      sessionUpdate: "usage_update",
                      used: 14_000,
                      size: 1_048_576,
                    });
                    yield* Deferred.await(waitingGate);

                    // Background command completes and agent wakes inside the SAME prompt.
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "bg_bench",
                      status: "completed",
                      rawOutput: { output: "score: 99\n", exit_code: 0 },
                    });
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Both finished cleanly." },
                    });
                    yield* Deferred.await(wakeGate);
                    yield* send({
                      sessionUpdate: "usage_update",
                      used: 16_000,
                      size: 1_048_576,
                    });
                    yield* Deferred.await(finishPromptGate);
                    return {
                      stopReason: "end_turn",
                      usage: {
                        inputTokens: 4_000,
                        cachedReadTokens: 12_000,
                        cachedWriteTokens: 0,
                        outputTokens: 320,
                        thoughtTokens: 100,
                        totalTokens: 16_320,
                      },
                    };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });

        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-1516-waiting"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );

        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const waitFor = <A>(
          match: (event: ProviderAdapter.ProviderAdapterV2Event) => A | undefined,
        ) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              seen.push(event);
              const matched = match(event);
              if (matched !== undefined) return matched;
            }
          });

        // Wait for all tasks so an update from midway through the launch cannot satisfy this check.
        const waitingThread = yield* waitFor((event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.waitingOnBackgroundWork === true &&
          event.providerThread.pendingBackgroundTasks?.length === 3
            ? event.providerThread
            : undefined,
        );
        assert.deepEqual(
          waitingThread.pendingBackgroundTasks?.map((task) => ({
            taskId: task.taskId,
            kind: task.kind,
            description: task.description,
            wakesAgent: task.kind === "command" ? task.wakesAgent : undefined,
          })),
          [
            {
              taskId: "colors",
              kind: "subagent",
              description: "colors",
              wakesAgent: undefined,
            },
            {
              taskId: "fruits",
              kind: "subagent",
              description: "fruits",
              wakesAgent: undefined,
            },
            {
              taskId: "bg_bench",
              kind: "command",
              description: "Run full benchmark",
              wakesAgent: true,
            },
          ],
        );

        // 2. When the background command completes and the agent wakes up, waiting clears back to Working.
        yield* Deferred.succeed(waitingGate, undefined);
        const resumedThread = yield* waitFor((event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.waitingOnBackgroundWork === undefined &&
          (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0
            ? event.providerThread
            : undefined,
        );
        assert.isUndefined(resumedThread.waitingOnBackgroundWork);

        // The prompt response closes the run; the worker launch ACK alone cannot close it.
        yield* Deferred.succeed(wakeGate, undefined);
        yield* Deferred.succeed(finishPromptGate, undefined);
        const terminal = yield* waitFor((event) =>
          event.type === "turn.terminal" ? event : undefined,
        );
        assert.equal(terminal.status, "completed");
        assert.notProperty(terminal, "continuationExpected");
        for (const name of ["colors", "fruits"]) {
          const updates = seen.flatMap((event) =>
            event.type === "subagent.updated" && event.subagent.title === name
              ? [event.subagent]
              : [],
          );
          assert.deepEqual(
            updates.map((task) => task.status),
            ["pending", "running", "idle"],
          );
          const workerModel = name === "colors" ? "gemini-3.8-flash" : modelSelection.model;
          assert.isTrue(updates.every((task) => task.model === workerModel));
        }
        assert.isFalse(
          seen.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.title === "Running swarm",
          ),
        );
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "does not set waitingOnBackgroundWork for a daemon command on 1.5.16 and keeps pre-1.5.15 deferred finalize intact on 1.5.14",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "antigravity-1516-daemon-",
        });
        const instanceId = ProviderInstanceId.make("antigravity-1516-daemon");
        const threadId = ThreadId.make("thread-antigravity-1516-daemon");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let onSessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;

        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.16" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    onSessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: (_payload, promptOptions) =>
                  Effect.gen(function* () {
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      onSessionUpdate?.(
                        normalizeAntigravitySessionUpdate({
                          sessionId: "mock-session-1",
                          update,
                        }),
                      ) ?? Effect.void;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId: "daemon_dev",
                      title: "npm run dev",
                      kind: "execute",
                      status: "in_progress",
                      rawInput: {
                        CommandLine: "npm run dev",
                        IsDaemon: true,
                        WaitMsBeforeAsync: 500,
                      },
                    });
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Dev server started." },
                    });
                    yield* send({
                      sessionUpdate: "usage_update",
                      used: 12_000,
                      size: 1_048_576,
                    });
                    return { stopReason: "end_turn" };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-1516-daemon"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        );
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "turn.terminal") break;
        }
        assert.isFalse(
          seen.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.waitingOnBackgroundWork === true,
          ),
        );
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
