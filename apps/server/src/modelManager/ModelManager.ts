/**
 * The model list's "Add or remove a model": one reusable Models chat, run by Codex on
 * GPT-6.1 Terra at high reasoning (else a ready agent's default model), edits a harness's
 * own config so a new model shows up (an OpenRouter model OpenCode or Pi doesn't list
 * yet). The agent follows a playbook
 * this service rewrites before every request; when its turn ends the server restarts
 * OpenCode's servers and refreshes every harness's model list.
 *
 * @module modelManager/ModelManager
 */
import {
  CommandId,
  MessageId,
  ModelManagerError,
  MODEL_MANAGER_THREAD_ID_PREFIX,
  ProviderDriverKind,
  type ModelManagerReply,
  type ModelManagerRequest,
  type ModelSelection,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readyProviderModelSelection } from "@t3tools/shared/serverSettings";
import { modelManagerPlaybook, pathEnvironmentOf, type PlaybookHarness } from "./playbook.ts";

const FOLDER = "model-manager";
const STATE_FILE = "state.json";
const PLAYBOOK_FILE = "PLAYBOOK.md";
const THREAD_TITLE = "Models";
/** Fast and careful enough for config edits; the first one Codex offers wins. */
const MANAGER_MODELS = ["gpt-6.1-terra", "gpt-6-luna"] as const;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

const ManagerState = Schema.Struct({ threadId: ThreadId });
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(ManagerState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(ManagerState));

/**
 * Codex on the first manager model it lists, at high reasoning; without one, a
 * ready provider's own default model.
 */
export function managerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const codex = providers.filter((provider) => provider.driver === "codex" && provider.enabled);
  for (const model of MANAGER_MODELS) {
    const provider = codex.find((candidate) =>
      candidate.models.some((entry) => entry.slug === model),
    );
    if (provider !== undefined)
      return {
        instanceId: provider.instanceId,
        model,
        options: [{ id: "reasoningEffort", value: "high" }],
      };
  }
  return readyProviderModelSelection(providers);
}

export function managerMessage(input: {
  readonly text: string;
  readonly harness: PlaybookHarness;
  readonly playbookPath: string;
}): string {
  return `${input.text}

Harness: ${input.harness.displayName} (instance \`${input.harness.instanceId}\`, driver \`${input.harness.driver}\`).
Read ${input.playbookPath} first and follow it; SSHCode rewrites it for every request.`;
}

export class ModelManager extends Context.Service<
  ModelManager,
  {
    readonly request: (
      input: ModelManagerRequest,
    ) => Effect.Effect<ModelManagerReply, ModelManagerError>;
  }
>()("t3/modelManager/ModelManager") {}

const fail = (message: string) => new ModelManagerError({ message });

export const layer = Layer.effect(
  ModelManager,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const context = yield* Effect.context<
      | Effect.Services<ReturnType<typeof ThreadMessageIntake.launchThread>>
      | Effect.Services<ReturnType<typeof ThreadMessageIntake.sendToThread>>
    >();

    const folder = path.join(config.stateDir, FOLDER);
    const statePath = path.join(folder, STATE_FILE);
    const playbookPath = path.join(folder, PLAYBOOK_FILE);
    const managerThread = yield* Ref.make<ThreadId | null>(
      yield* fs.readFileString(statePath).pipe(
        Effect.map((text) =>
          Option.getOrNull(Option.map(decodeState(text), (state) => state.threadId)),
        ),
        Effect.orElseSucceed(() => null),
      ),
    );

    const harnesses = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
      const configured = (current?.providerInstances ?? {}) as Readonly<
        Record<string, { readonly environment?: unknown; readonly config?: unknown }>
      >;
      const snapshots = yield* providers.getProviders;
      const listed = yield* instances.listInstances;
      return listed.map((instance): PlaybookHarness => {
        const entry = configured[instance.instanceId];
        const instanceConfig =
          entry?.config !== null && typeof entry?.config === "object"
            ? (entry.config as Record<string, unknown>)
            : {};
        const snapshot = snapshots.find((provider) => provider.instanceId === instance.instanceId);
        const binaryPath =
          typeof instanceConfig.binaryPath === "string" ? instanceConfig.binaryPath : undefined;
        const pathEnvironment = pathEnvironmentOf(entry?.environment);
        return {
          instanceId: instance.instanceId,
          driver: instance.driverKind,
          displayName: instance.displayName ?? snapshot?.displayName ?? instance.instanceId,
          enabled: instance.enabled,
          ...(binaryPath ? { binaryPath } : {}),
          ...(pathEnvironment ? { pathEnvironment } : {}),
        };
      });
    });

    const enable = (instanceId: ModelManagerRequest["instanceId"], driver: string) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings;
        const existing = current.providerInstances?.[instanceId];
        const existingConfig =
          existing?.config !== null && typeof existing?.config === "object"
            ? (existing.config as Record<string, unknown>)
            : {};
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...(existing ?? { driver: ProviderDriverKind.make(driver) }),
            enabled: true,
            config: { ...existingConfig, enabled: true },
          },
        });
      }).pipe(Effect.mapError(() => fail("Couldn't turn that harness on in Settings.")));

    const reusableThread = (threadId: ThreadId) =>
      threads.getThreadRecords(threadId, []).pipe(
        Effect.map(({ thread }) =>
          thread.archivedAt === null && thread.deletedAt === null
            ? Option.some(thread)
            : Option.none(),
        ),
        Effect.orElseSucceed(() => Option.none()),
      );

    const newIds = Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      return {
        commandId: CommandId.make(`${MODEL_MANAGER_THREAD_ID_PREFIX}${uuid}`),
        messageId: MessageId.make(`models:${uuid}`),
      };
    });

    const request = Effect.fn("ModelManager.request")(function* (input: ModelManagerRequest) {
      const all = yield* harnesses;
      const harness = all.find((candidate) => candidate.instanceId === input.instanceId);
      if (harness === undefined)
        return yield* fail("That harness isn't on this Mac; pick one from the list.");
      const modelSelection = managerModelSelection(yield* providers.getProviders);
      if (modelSelection === null)
        return yield* fail(
          "The Models chat needs a ready agent. Set one up in Settings → Providers.",
        );

      // Pi starts off; asking for a model in it is asking to use it.
      if (!harness.enabled) yield* enable(input.instanceId, harness.driver);

      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.ignore);
      yield* fs
        .writeFileString(playbookPath, modelManagerPlaybook(all))
        .pipe(Effect.mapError(() => fail("Couldn't write the Models playbook.")));
      const text = managerMessage({ text: input.text, harness, playbookPath });
      const { commandId, messageId } = yield* newIds;

      const existing = yield* Ref.get(managerThread);
      const thread = existing === null ? Option.none() : yield* reusableThread(existing);
      if (Option.isSome(thread)) {
        const sent = yield* ThreadMessageIntake.sendToThread({
          projectId: thread.value.projectId,
          commandId,
          threadId: thread.value.id,
          messageId,
          text,
          attachments: [],
          modelSelection,
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        }).pipe(
          Effect.provide(context),
          Effect.mapError((error) => fail(`Couldn't send to the Models chat: ${error.message}`)),
        );
        return {
          threadId: thread.value.id,
          delivery: sent.delivery === "queued" ? "queued" : "started",
          runId: sent.run.id,
        } as const;
      }

      const { projectId } = yield* folders.ensureScratchProject.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const threadId = ThreadId.make(commandId);
      const launched = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: THREAD_TITLE,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId, text, attachments: [] },
        createdBy: "user",
        creationSource: "server",
      }).pipe(
        Effect.provide(context),
        Effect.mapError((error) => fail(`Couldn't start the Models chat: ${error.message}`)),
      );
      yield* Ref.set(managerThread, launched.threadId);
      yield* fs
        .writeFileString(statePath, encodeState({ threadId: launched.threadId }))
        .pipe(Effect.ignore);
      const run = launched.projection.runs.find((entry) => entry.userMessageId === messageId);
      return { threadId: launched.threadId, delivery: "started", runId: run?.id ?? null } as const;
    });

    // When a Models turn ends, restart OpenCode's servers (they read their config only at
    // start) and refresh every local harness, so an added model appears in the list.
    const refreshAfterTurn = Effect.gen(function* () {
      const listed = yield* instances.listInstances;
      yield* Effect.forEach(listed, (instance) => instance.invalidateCaches ?? Effect.void, {
        discard: true,
      });
      yield* providers.refresh().pipe(Effect.ignore);
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated" || !TERMINAL_RUN_STATUSES.has(event.payload.status))
            return;
          if (event.payload.threadId !== (yield* Ref.get(managerThread))) return;
          yield* refreshAfterTurn;
        }),
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Models chat refresh stopped", { cause })),
      ),
    );

    return ModelManager.of({ request });
  }),
);
