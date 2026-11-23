import { isDirectLocalRequest, type requestProvenance } from "../requestProvenance.ts";
import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  ProviderDriverKind,
  TurnItemId,
  TerminalHandoffError,
  type ProviderInstanceConfig,
  type OrchestrationV2DomainEvent,
  type TerminalHandoffStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { INHERITED_AGENT_SESSION_MARKERS } from "@t3tools/shared/agentSessionMarkers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "../project/ProjectService.ts";
import {
  resolveCodexHomeLayout,
  withCodexSqliteHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as State from "./TerminalHandoffState.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

/** A single POSIX shell word. Shell syntax is never interpolated into the payload. */
export function quoteTerminalWord(value: string): string {
  if (value.includes("\0")) throw new Error("A shell word cannot contain NUL.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isLocalTerminalClient(input: {
  readonly provenance: ReturnType<typeof requestProvenance>;
  readonly surface: string | undefined;
  readonly connectionMethod: unknown;
}): boolean {
  return (
    isDirectLocalRequest(input.provenance) &&
    input.surface !== "mobile" &&
    input.connectionMethod !== "ssh" &&
    input.connectionMethod !== "relay" &&
    (input.provenance.origin === undefined ||
      input.provenance.origin === "t3code://app" ||
      /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(input.provenance.origin))
  );
}

export function terminalUnavailableReason(input: {
  readonly localClient: boolean;
  readonly platform: string;
  readonly driver: string;
  readonly nativeId: string | undefined;
  readonly managed: boolean;
  readonly customEnvironment: boolean;
}): string | null {
  if (input.driver !== "codex" && input.driver !== "claudeAgent")
    return "This CLI cannot resume chats";
  if (!input.localClient || input.platform !== "darwin") return "Available on the local Mac";
  if (input.managed) return "Uses an SSHCode-managed runtime";
  if (input.customEnvironment) return "Uses a custom CLI environment";
  if (!input.nativeId) return "Send a message first";
  return null;
}

const SAFE_ENVIRONMENT = new Set([
  "HOME",
  "PATH",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CLAUDE_CONFIG_DIR",
]);
export const buildTerminalCommand = Effect.fn("TerminalHandoff.buildCommand")(function* (input: {
  readonly instance: ProviderInstanceConfig;
  readonly nativeId: string;
  readonly cwd: string;
}) {
  const home = yield* HostProcess.HomeDirectory;
  const inherited = yield* HostProcess.Environment;
  const environment = yield* mergeProviderInstanceEnvironment(
    input.instance.environment,
    inherited,
  );
  let binary: string;
  let args: string[];
  let effective: NodeJS.ProcessEnv;
  if (input.instance.driver === "codex") {
    const config = yield* decodeCodexSettings(input.instance.config ?? {});
    if (config.setupMode === "managed")
      return yield* new TerminalHandoffError({ message: "Uses an SSHCode-managed runtime" });
    const layout = yield* resolveCodexHomeLayout(config);
    effective = withCodexSqliteHome(layout, {
      ...environment,
      CODEX_HOME: layout.effectiveHomePath ?? environment.CODEX_HOME,
    });
    binary = config.binaryPath;
    args = ["resume", input.nativeId];
  } else {
    const config = yield* decodeClaudeSettings(input.instance.config ?? {});
    effective = yield* makeClaudeEnvironment(config, environment);
    binary = config.binaryPath;
    args = ["--resume", input.nativeId];
  }
  const resolve = yield* SpawnExecutableResolution;
  const executable = resolve(expandHomePath(binary, home), "darwin", environment);
  if (!executable)
    return yield* new TerminalHandoffError({
      message: "Couldn't find this chat's CLI. Check its binary path.",
    });
  // Copy only paths, never access tokens or arbitrary instance variables.
  const variables = Object.fromEntries(
    [...SAFE_ENVIRONMENT].flatMap((key) => {
      const value = key === "HOME" ? (effective.HOME ?? home) : effective[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return { executable, args, cwd: input.cwd, environment: variables };
});

function terminalCommandScript(command: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}) {
  return [
    "#!/bin/sh",
    "set -eu",
    '/bin/rm -f -- "$0"',
    `cd ${quoteTerminalWord(command.cwd)}`,
    // A Terminal opened from inside an agent hands its markers to every window;
    // the CLI would then run as that agent's child and skip saving its transcript.
    `unset ${INHERITED_AGENT_SESSION_MARKERS.join(" ")}`,
    ...Object.entries(command.environment).map(
      ([key, value]) => `export ${key}=${quoteTerminalWord(value)}`,
    ),
    `exec ${[command.executable, ...command.args].map(quoteTerminalWord).join(" ")}`,
    "",
  ].join("\n");
}

export function terminalContinuationDivider(startedAt: string, endedAt: string): string {
  const format = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `Continued in Terminal, ${format.formatRange(DateTime.toEpochMillis(DateTime.makeUnsafe(startedAt)), DateTime.toEpochMillis(DateTime.makeUnsafe(endedAt)))}. The agent remembers it; those messages aren't shown here.`;
}

export class TerminalLauncher extends Context.Service<
  TerminalLauncher,
  {
    readonly launch: (script: string) => Effect.Effect<void, TerminalHandoffError>;
  }
>()("t3/orchestration-v2/TerminalHandoffService/TerminalLauncher") {}

export const layerLauncher = Layer.effect(
  TerminalLauncher,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const config = yield* ServerConfig.ServerConfig;
    const directory = path.join(config.stateDir, "terminal-handoffs");
    const prepare = Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      for (const entry of yield* fs.readDirectory(directory)) {
        if (entry.endsWith(".command")) yield* fs.remove(path.join(directory, entry));
      }
    });
    // Old launch files have no credentials, but remove leftovers on the next start.
    if (platform === "darwin") yield* prepare.pipe(Effect.orDie);
    return TerminalLauncher.of({
      launch: (script) =>
        Effect.gen(function* () {
          if (platform !== "darwin")
            return yield* new TerminalHandoffError({ message: "Available on the local Mac" });
          const file = path.join(
            directory,
            `${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.command`,
          );
          yield* fs.writeFileString(file, script, { mode: 0o700, flag: "wx" });
          const opened = yield* runner
            .run({ command: "/usr/bin/open", args: ["-a", "Terminal", file], timeout: "5 seconds" })
            .pipe(Effect.onError(() => fs.remove(file).pipe(Effect.ignore)));
          if (opened.code !== 0) {
            yield* fs.remove(file).pipe(Effect.ignore);
            return yield* new TerminalHandoffError({
              message: "Couldn't hand this chat to Terminal. Try again.",
            });
          }
        }).pipe(
          Effect.mapError(
            () =>
              new TerminalHandoffError({
                message: "Couldn't hand this chat to Terminal. Try again.",
              }),
          ),
        ),
    });
  }),
);

export class TerminalHandoffService extends Context.Service<
  TerminalHandoffService,
  {
    readonly watch: (
      threadId: ThreadId,
      localClient: boolean,
    ) => Stream.Stream<TerminalHandoffStatus, TerminalHandoffError>;
    readonly open: (
      threadId: ThreadId,
      localClient: boolean,
    ) => Effect.Effect<void, TerminalHandoffError>;
    readonly bringBack: (threadId: ThreadId) => Effect.Effect<void, TerminalHandoffError>;
  }
>()("t3/orchestration-v2/TerminalHandoffService") {}

export const layer = Layer.effect(
  TerminalHandoffService,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const state = yield* State.TerminalHandoffState;
    const threads = yield* Threads.ThreadManagementService;
    const sessions = yield* Sessions.ProviderSessionManagerV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const projects = yield* Projects.ProjectService;
    const launcher = yield* TerminalLauncher;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    const failure = () =>
      new TerminalHandoffError({ message: "Couldn't hand this chat to Terminal. Try again." });
    const resolve = Effect.fn("TerminalHandoff.resolve")(function* (
      threadId: ThreadId,
      localClient: boolean,
    ) {
      const records = yield* threads.getThreadRecords(threadId, ["providerThreads"]);
      const provider = records.providerThreads.find(
        (p) => p.id === records.thread.activeProviderThreadId,
      );
      const instanceId = records.thread.modelSelection.instanceId;
      const config = (yield* settings.getSettings).providerInstances[instanceId];
      const driver =
        config?.driver ??
        (instanceId === "codex" || instanceId === "claudeAgent" ? instanceId : "unknown");
      const instance: ProviderInstanceConfig = config ?? {
        driver: ProviderDriverKind.make(driver),
        config: {},
      };
      const codex = driver === "codex" ? yield* decodeCodexSettings(instance.config ?? {}) : null;
      const nativeId =
        provider?.providerInstanceId === instanceId && provider.driver === driver
          ? provider.nativeThreadRef?.nativeId
          : undefined;
      let reason = terminalUnavailableReason({
        localClient: localClient && !hostEnvironment.SSH_CONNECTION && !hostEnvironment.SSH_TTY,
        platform,
        driver,
        nativeId: nativeId ?? undefined,
        managed: codex?.setupMode === "managed",
        customEnvironment:
          instance.environment?.some((v) => v.sensitive || !SAFE_ENVIRONMENT.has(v.name)) ?? false,
      });
      if (reason === null && nativeId != null) {
        reason = yield* buildTerminalCommand({
          instance,
          nativeId,
          cwd: records.thread.worktreePath ?? "/",
        }).pipe(
          Effect.provideService(Path.Path, path),
          Effect.map(() => null),
          Effect.catch(() => Effect.succeed("This chat's CLI isn't available")),
        );
      }
      return { records, provider, instance, nativeId, reason };
    });
    return TerminalHandoffService.of({
      watch: (id, localClient) =>
        Stream.merge(
          state.changes(id),
          threads.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.threadId === id && event.type === "provider-thread.updated",
            ),
            Stream.map(() => state.get(id)),
            Stream.mapError(failure),
          ),
        ).pipe(
          Stream.mapEffect((status) =>
            resolve(id, localClient).pipe(
              Effect.map(({ reason }) => ({ ...status, unavailableReason: reason })),
              Effect.mapError(failure),
            ),
          ),
        ),
      open: (id, localClient) =>
        state
          .handoff(
            id,
            Effect.gen(function* () {
              const { records, provider, instance, nativeId, reason } = yield* resolve(
                id,
                localClient,
              );
              if (reason !== null || nativeId == null || provider == null)
                return yield* new TerminalHandoffError({
                  message: reason ?? "Send a message first",
                });
              const project = yield* projects.getById(records.thread.projectId);
              const cwd =
                records.thread.worktreePath ??
                (Option.isSome(project) ? project.value.workspaceRoot : null);
              if (cwd === null) return yield* failure();
              const command = yield* buildTerminalCommand({ instance, nativeId, cwd }).pipe(
                Effect.provideService(Path.Path, path),
              );
              yield* threads.dispatch({
                type: "thread.stop",
                threadId: id,
                commandId: CommandId.make(
                  `terminal:stop:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
                ),
              });
              if (sessions.releaseConfirmed === undefined) return yield* failure();
              // Stop is asynchronous. Confirmed scope close is the process-exit barrier.
              if (provider.providerSessionId !== null)
                yield* sessions.releaseConfirmed(provider.providerSessionId, id);
              return terminalCommandScript(command);
            }),
            (script) => launcher.launch(script),
          )
          .pipe(Effect.mapError(failure)),
      bringBack: (id) =>
        state
          .bringBack(id, (startedAt) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const records = yield* threads.getThreadRecords(id, ["providerThreads"]);
              const active = records.providerThreads.find(
                (provider) => provider.id === records.thread.activeProviderThreadId,
              );
              const resumeLatest: OrchestrationV2DomainEvent[] = [];
              // Rollback can leave an explicit resume point. Terminal has now
              // continued the native session, so the next turn follows its tail.
              if (active?.nativeConversationHeadRef != null) {
                resumeLatest.push({
                  id: yield* ids.allocate.event({ threadId: id }),
                  type: "provider-thread.updated",
                  threadId: id,
                  occurredAt: now,
                  payload: {
                    ...active,
                    nativeConversationHeadRef: null,
                    contextUsage: null,
                    updatedAt: now,
                  },
                });
              }
              yield* sink.write({
                events: [
                  ...resumeLatest,
                  {
                    id: yield* ids.allocate.event({ threadId: id }),
                    type: "turn-item.updated",
                    threadId: id,
                    occurredAt: now,
                    payload: {
                      id: TurnItemId.make(
                        `terminal:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
                      ),
                      threadId: id,
                      runId: null,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: yield* projections.getNextTurnItemOrdinal(id),
                      status: "completed",
                      type: "system_notice",
                      title: "Continued in Terminal",
                      message: terminalContinuationDivider(startedAt, DateTime.formatIso(now)),
                      startedAt: now,
                      updatedAt: now,
                      completedAt: now,
                    },
                  },
                ],
              });
            }),
          )
          .pipe(
            Effect.mapError(
              () =>
                new TerminalHandoffError({ message: "Couldn't bring this chat back. Try again." }),
            ),
          ),
    });
  }),
);
