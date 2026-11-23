import { type PreviewTabId, type PreviewAutomationStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { type McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Host from "./QaSandboxHost.ts";

export const QaSandboxInput = Schema.Struct({
  action: Schema.Literals(["start", "stop", "status"]),
  id: Schema.optional(Schema.String),
  repositoryPath: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.Literal("chat")),
});

interface Sandbox {
  readonly owner: string;
  readonly scope: McpThreadInvocationScope;
  readonly files: Host.SandboxFiles;
  tabId?: PreviewTabId;
  readyMs: number;
  usedAt: number;
  seeded: boolean;
}

const ownerKey = (scope: McpThreadInvocationScope) =>
  `${scope.environmentId}:${scope.thread.threadId}`;
/** Words the fake model reacts to anywhere in a prompt (apps/server/scripts/acp-mock-agent.ts). */
const FIXTURE_PROMPTS =
  "qa:fail = provider error; qa:wait = 2 min run; qa:stream = 30 s text stream; qa:long = 300 tool calls; qa:secret, qa:ask, qa:delegate = secret card, question card, subagent";

const summary = (sandbox: Sandbox) => ({
  id: sandbox.files.id,
  url: `http://127.0.0.1:${sandbox.files.serverPort}/`,
  tabId: sandbox.tabId,
  readyMs: sandbox.readyMs,
});

export class QaSandbox extends Context.Service<
  QaSandbox,
  {
    readonly run: (
      scope: McpThreadInvocationScope,
      input: typeof QaSandboxInput.Type,
    ) => Effect.Effect<Readonly<Record<string, unknown>>>;
    readonly touch: (scope: McpThreadInvocationScope) => Effect.Effect<void>;
  }
>()("t3/preview/QaSandbox") {}

export const make = Effect.gen(function* () {
  const host = yield* Host.QaSandboxHost;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const sandboxes = new Map<string, Sandbox>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (owner: string) => {
    let lock = locks.get(owner);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(owner, lock);
    }
    return lock;
  };

  const stop = Effect.fn("QaSandbox.stop")(function* (sandbox: Sandbox, keepLog = false) {
    yield* host.dispose(sandbox.files, keepLog);
    if (sandbox.tabId !== undefined) {
      yield* broker
        .invoke({
          scope: sandbox.scope,
          serverOnly: true,
          operation: "close",
          input: {},
          tabId: sandbox.tabId,
          timeoutMs: 2_000,
          updateCurrentTab: false,
        })
        .pipe(Effect.ignore);
    }
    sandboxes.delete(sandbox.files.id);
  }, Effect.uninterruptible);
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sandboxes.values()], (sandbox) => stop(sandbox).pipe(Effect.ignore), {
      discard: true,
    }),
  );
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const sandbox of sandboxes.values()) {
      if (now - sandbox.usedAt >= 30 * 60_000)
        yield* lockFor(sandbox.owner).withPermit(
          Effect.suspend(() =>
            now - sandbox.usedAt >= 30 * 60_000 ? stop(sandbox).pipe(Effect.ignore) : Effect.void,
          ),
        );
    }
  }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  const touch = (scope: McpThreadInvocationScope) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const sandbox of sandboxes.values())
        if (sandbox.owner === ownerKey(scope)) sandbox.usedAt = now;
    });

  const run = (scope: McpThreadInvocationScope, input: typeof QaSandboxInput.Type) =>
    Effect.gen(function* () {
      const owner = ownerKey(scope);
      const owned = [...sandboxes.values()].filter((sandbox) => sandbox.owner === owner);
      if (input.action === "status") {
        yield* touch(scope);
        return { sandboxes: owned.map(summary) };
      }
      if (input.action === "stop") {
        const targets =
          input.id === undefined ? owned : owned.filter((sandbox) => sandbox.files.id === input.id);
        for (const sandbox of targets) yield* stop(sandbox);
        return { stopped: targets.map((sandbox) => sandbox.files.id) };
      }
      const startedAt = yield* Clock.currentTimeMillis;
      const id = yield* crypto.randomUUIDv4();
      const logPath = `/private/tmp/t3-qa-${id}.log`;
      let stage = "checkout";
      const start = Effect.gen(function* () {
        let repositoryPath = input.repositoryPath;
        if (repositoryPath === undefined) {
          const thread = yield* threads.getThreadShell(scope.thread.threadId);
          if (thread === null)
            return yield* Effect.fail(
              new Host.QaSandboxHostError({
                stage: "checkout",
                cause: "Calling thread is missing.",
              }),
            );
          const project = yield* projects.getById(thread.projectId);
          if (Option.isNone(project))
            return yield* Effect.fail(
              new Host.QaSandboxHostError({
                stage: "checkout",
                cause: "Calling project is missing.",
              }),
            );
          repositoryPath = thread.worktreePath ?? project.value.workspaceRoot;
        }
        // A running sandbox for this checkout already serves its current code (Vite rebuilds
        // on change): hand it back instead of paying a cold start again.
        const resolved = yield* fs
          .realPath(repositoryPath)
          .pipe(Effect.orElseSucceed(() => repositoryPath));
        const running = owned.find(
          (sandbox) => sandbox.files.repositoryPath === resolved && sandbox.tabId !== undefined,
        );
        if (running) {
          stage = "seed";
          if (input.seed === "chat" && !running.seeded) {
            yield* host.seed(running.files);
            running.seeded = true;
          }
          running.usedAt = yield* Clock.currentTimeMillis;
          return { ...summary(running), reused: true, fixturePrompts: FIXTURE_PROMPTS };
        }
        const first = owned[0];
        if (owned.length >= 2 && first) {
          yield* fs
            .writeFileString(first.files.logPath, "QA sandbox limit reached.\n", { flag: "a" })
            .pipe(Effect.ignore);
          return {
            error: "Stop an existing QA sandbox before starting another.",
            logPath: first.files.logPath,
          };
        }
        stage = "prepare";
        const checkout = repositoryPath;
        const sandbox = yield* Effect.gen(function* () {
          const files = yield* host.prepare(id, checkout);
          const sandbox: Sandbox = {
            owner,
            scope,
            files,
            readyMs: 0,
            usedAt: startedAt,
            seeded: false,
          };
          sandboxes.set(id, sandbox);
          stage = "launch";
          yield* host.launch(files);
          return sandbox;
        }).pipe(Effect.uninterruptible);
        const files = sandbox.files;
        stage = "readiness";
        yield* host.ready(files);
        stage = "pairing";
        const url = yield* host.pair(files);
        stage = "preview";
        const tab = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          serverOnly: true,
          operation: "open",
          input: { url, open: false, show: false, reuseExistingTab: false, profileId: "incognito" },
          timeoutMs: 60_000,
        });
        if (!tab.tabId)
          return yield* Effect.fail(
            new Host.QaSandboxHostError({
              stage: "preview",
              cause: "Preview did not return a tab.",
            }),
          );
        sandbox.tabId = tab.tabId;
        stage = "seed";
        if (input.seed === "chat") {
          yield* host.seed(files);
          sandbox.seeded = true;
        }
        stage = "preview";
        // Pairing must finish before callers inspect the picker. Never return the credential.
        yield* broker.invoke({
          scope,
          serverOnly: true,
          operation: "waitFor",
          tabId: tab.tabId,
          input: { selector: "[data-sidebar]", timeoutMs: 60_000 },
          timeoutMs: 60_000,
        });
        const now = yield* Clock.currentTimeMillis;
        sandbox.readyMs = now - startedAt;
        sandbox.usedAt = now;
        return { ...summary(sandbox), fixturePrompts: FIXTURE_PROMPTS };
      });
      return yield* start.pipe(
        Effect.onInterrupt(() => {
          const sandbox = sandboxes.get(id);
          return sandbox ? stop(sandbox).pipe(Effect.ignore) : Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(logPath, String(cause), { flag: "a" }).pipe(Effect.ignore);
            const sandbox = sandboxes.get(id);
            if (sandbox) yield* stop(sandbox, true).pipe(Effect.ignore);
            return { error: `QA sandbox ${stage} failed.`, logPath };
          }),
        ),
      );
    }).pipe(
      lockFor(ownerKey(scope)).withPermit,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failed = [...sandboxes.values()].find(
            (sandbox) => sandbox.owner === ownerKey(scope),
          );
          const logPath = failed?.files.logPath ?? "/private/tmp/t3-qa-cleanup.log";
          yield* fs.writeFileString(logPath, String(cause), { flag: "a" }).pipe(Effect.ignore);
          return { error: "QA sandbox cleanup failed; retry stop.", logPath };
        }),
      ),
    );

  return QaSandbox.of({ run, touch });
});

export const layer = Layer.effect(QaSandbox, make).pipe(Layer.provide(Host.layer));
