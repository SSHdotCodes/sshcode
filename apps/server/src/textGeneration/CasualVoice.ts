import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Stream from "effect/Stream";
import {
  CasualVoiceBackend,
  CasualVoiceDecision,
  CasualVoiceError,
  CasualVoiceMode,
  TextGenerationError,
  type CasualVoiceRequest,
  type CasualVoiceReply,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { selectStyleExamples } from "./casualVoiceText.ts";
import {
  segmentCasualMessage,
  parseCasualDecisions,
  parseCasualVerdict,
  casualVoiceInstructions,
  cloudCasualVoicePrompt,
  casualVoiceCloudOptions,
  casualVoiceEffortDescriptor,
  casualMessageRole,
  selectSteerReasoningReplies,
  type CasualVoiceInput,
} from "@t3tools/shared/casualVoice";
import type { CasualVoiceDisplay, CasualVoiceRole } from "@t3tools/contracts";

const CacheEntry = Schema.Struct({
  key: Schema.String,
  messageId: Schema.String,
  threadId: Schema.String,
  text: Schema.NullOr(Schema.String),
  decision: Schema.optionalKey(CasualVoiceDecision),
  at: Schema.Number,
});
const Document = Schema.Struct({
  version: Schema.Literal(1),
  backend: Schema.NullOr(CasualVoiceBackend),
  mode: Schema.optionalKey(CasualVoiceMode),
  cloudBackend: Schema.optionalKey(Schema.NullOr(CasualVoiceBackend)),
  saveTraining: Schema.optionalKey(Schema.Boolean),
  chats: Schema.Record(Schema.String, Schema.Boolean),
  entries: Schema.Array(CacheEntry),
});
export type CasualVoiceSettings = {
  readonly backend: CasualVoiceBackend | null;
  readonly cloudBackend?: CasualVoiceBackend | null;
  readonly mode?: CasualVoiceMode;
};
export function casualVoiceTargets(settings: CasualVoiceSettings) {
  const local = settings.backend?.kind === "local" ? settings.backend : null;
  const cloud =
    settings.cloudBackend?.kind === "provider"
      ? settings.cloudBackend
      : settings.backend?.kind === "provider"
        ? settings.backend
        : null;
  return { local, cloud };
}
/** Explicit mode wins. Both backends with no mode means local messages and cloud steers. */
export function presentedCasualVoiceMode(settings: CasualVoiceSettings): CasualVoiceMode {
  if (settings.mode) return settings.mode;
  const { local, cloud } = casualVoiceTargets(settings);
  if (local && settings.cloudBackend?.kind === "provider") return "hybrid";
  if (cloud) return "cloud";
  return "local";
}
export function routeCasualVoice(
  settings: CasualVoiceSettings,
  source: "message" | "reasoning",
): {
  readonly backend: CasualVoiceBackend | null;
  readonly omitExamples: boolean;
  readonly mode: CasualVoiceMode;
} {
  const { local, cloud } = casualVoiceTargets(settings);
  if (settings.mode === "local") return { backend: local, omitExamples: false, mode: "local" };
  if (settings.mode === "cloud") return { backend: cloud, omitExamples: false, mode: "cloud" };
  if (settings.mode === "hybrid" || (local && settings.cloudBackend?.kind === "provider"))
    return source === "reasoning"
      ? { backend: cloud, omitExamples: true, mode: "hybrid" }
      : { backend: local, omitExamples: false, mode: "hybrid" };
  if (!settings.mode && settings.cloudBackend?.kind === "provider")
    return { backend: settings.cloudBackend, omitExamples: false, mode: "cloud" };
  return {
    backend: settings.backend,
    omitExamples: false,
    mode: settings.backend?.kind === "provider" ? "cloud" : "local",
  };
}
type CatalogModel = {
  readonly instanceId: string;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
};
/** Fills the catalog's effort option. An explicit stored choice is kept. */
export function applyCasualVoiceEffort<T extends CasualVoiceBackend | null>(
  backend: T,
  models: ReadonlyArray<CatalogModel>,
): T {
  if (backend?.kind !== "provider") return backend;
  const descriptors = models.find(
    (model) =>
      model.instanceId === backend.modelSelection.instanceId &&
      model.model === backend.modelSelection.model,
  )?.optionDescriptors;
  const descriptor = casualVoiceEffortDescriptor(descriptors);
  const existing = descriptor
    ? backend.modelSelection.options?.find((option) => option.id === descriptor.id)
    : undefined;
  const options = casualVoiceCloudOptions(
    descriptors,
    typeof existing?.value === "string" ? existing.value : undefined,
    backend.modelSelection.options,
  );
  if (!options) return backend;
  return { ...backend, modelSelection: { ...backend.modelSelection, options } };
}
export const DATASET_FILE_BYTES = 25 * 1024 * 1024;
export const DATASET_TOTAL_BYTES = 200 * 1024 * 1024;
export const DATASET_DIRECTORY = "casual-voice-dataset";
export function planDatasetAppend(
  files: ReadonlyArray<{ readonly name: string; readonly bytes: number }>,
  addition: number,
  limits: { readonly fileBytes: number; readonly totalBytes: number } = {
    fileBytes: DATASET_FILE_BYTES,
    totalBytes: DATASET_TOTAL_BYTES,
  },
) {
  const parts = files
    .filter((file) => /^\d{6}\.jsonl$/.test(file.name))
    .toSorted((a, b) => (a.name < b.name ? -1 : 1));
  const last = parts.at(-1);
  const rotate = !last || last.bytes >= limits.fileBytes;
  const max = parts.reduce((n, file) => Math.max(n, Number(file.name.slice(0, 6))), 0);
  const file = rotate ? `${String(max + 1).padStart(6, "0")}.jsonl` : last.name;
  const older = rotate ? parts : parts.slice(0, -1);
  let total =
    older.reduce((sum, part) => sum + part.bytes, 0) + (rotate ? 0 : last.bytes) + addition;
  const remove: string[] = [];
  for (const part of older) {
    if (total <= limits.totalBytes) break;
    remove.push(part.name);
    total -= part.bytes;
  }
  return { file, remove };
}
export const CACHE_LIMIT = 256;
export const CACHE_BYTES = 2 * 1024 * 1024;
const FAILURE_AGE_MS = 60_000;
export const CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function boundedEntries(entries: ReadonlyArray<typeof CacheEntry.Type>, now: number) {
  let size = 0;
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()]
    .filter(
      (entry) =>
        now - entry.at <
          (entry.text === null && entry.decision === undefined ? FAILURE_AGE_MS : CACHE_AGE_MS) &&
        entry.at <= now,
    )
    .toSorted((a, b) => b.at - a.at)
    .filter((entry) => {
      size += (entry.text?.length ?? 0) * 2 + 200;
      return size <= CACHE_BYTES;
    })
    .slice(0, CACHE_LIMIT);
}

/** Both backends return v2 decision lines; validation stays outside the model boundary. */
export interface ProseRewriter {
  readonly rewrite: (
    input: CasualVoiceInput,
    examples: ReadonlyArray<string>,
  ) => Effect.Effect<string, TextGenerationError>;
}
const LocalReply = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
});
const decodeLocalReply = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalReply));
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(Document));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Omits keys an older file never had, so a cache save cannot invent a mode. */
const persistDocument = (value: typeof Document.Type) => ({
  version: value.version,
  backend: value.backend,
  chats: value.chats,
  entries: value.entries,
  ...(value.mode === undefined ? {} : { mode: value.mode }),
  ...(value.cloudBackend === undefined ? {} : { cloudBackend: value.cloudBackend }),
  ...(value.saveTraining === undefined ? {} : { saveTraining: value.saveTraining }),
});
const isCasualVoiceError = Schema.is(CasualVoiceError);
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export function localRewriter(url: string, model: string): ProseRewriter {
  return {
    rewrite: (input, examples) =>
      Effect.gen(function* () {
        const endpoint = yield* Effect.try(() => new URL(url.endsWith("/") ? url : `${url}/`));
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          return yield* Effect.fail(
            new TextGenerationError({ operation: "rewriteProse", detail: "Invalid endpoint." }),
          );
        const inputJson = yield* encodeKey(input);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.post(new URL("chat/completions", endpoint).href).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model,
              messages: [
                { role: "system", content: casualVoiceInstructions(examples, input.source) },
                { role: "user", content: inputJson },
              ],
              stream: false,
              max_tokens: 4096,
            }),
          ),
        );
        yield* HttpClientResponse.filterStatusOk(response);
        let bytes = 0;
        const decoder = new TextDecoder();
        const data = yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.length;
            return bytes > 128_000
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "rewriteProse",
                    detail: "Response too large.",
                  }),
                )
              : Effect.succeed(chunk);
          }),
          Stream.runFold(
            () => "",
            (text, chunk) => text + decoder.decode(chunk, { stream: true }),
          ),
        );
        const reply = yield* decodeLocalReply(data);
        return reply.choices[0]?.message.content ?? "";
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "rewriteProse",
              detail: "The endpoint could not rewrite this message.",
              cause,
            }),
        ),
      ),
  };
}
export function rewriteObserved(
  original: string,
  examples: ReadonlyArray<string>,
  rewriter: ProseRewriter,
  role: CasualVoiceRole = "final",
  timeoutMs = 10_000,
  replyTo?: string,
) {
  const source = segmentCasualMessage(
    original,
    role,
    replyTo === undefined ? undefined : { source: "reasoning", replyTo },
  );
  const failed = (reason: string) => ({
    output: "",
    display: null as CasualVoiceDisplay | null,
    decision: null as CasualVoiceDecision | null,
    reason,
    input: source.input,
  });
  return rewriter.rewrite(source.input, examples).pipe(
    Effect.map((output) => {
      const verdict = parseCasualVerdict(source, output);
      return verdict.accepted
        ? {
            output,
            display: verdict.display,
            decision: null as CasualVoiceDecision | null,
            reason: null as string | null,
            input: source.input,
          }
        : {
            output,
            display: null as CasualVoiceDisplay | null,
            decision: verdict.decision ?? null,
            reason: verdict.reason,
            input: source.input,
          };
    }),
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(failed("timeout")) }),
    Effect.catchCause(() => Effect.succeed(failed("unavailable"))),
  );
}
export function rewriteWithFallback(
  original: string,
  examples: ReadonlyArray<string>,
  rewriter: ProseRewriter,
  role: CasualVoiceRole = "final",
  timeoutMs = 10_000,
  replyTo?: string,
) {
  return rewriteObserved(original, examples, rewriter, role, timeoutMs, replyTo).pipe(
    Effect.map((result) =>
      result.display ? { output: result.output, display: result.display } : null,
    ),
  );
}

export class CasualVoice extends Context.Service<
  CasualVoice,
  {
    readonly request: (
      input: CasualVoiceRequest,
    ) => Effect.Effect<CasualVoiceReply, CasualVoiceError>;
  }
>()("t3/textGeneration/CasualVoice") {}

/** A style file outside the server data folder; null, or a missing file, uses the data folder's. */
export const DefaultStyleFile = Context.Reference<string | null>(
  "t3/casualVoice/defaultStyleFile",
  { defaultValue: () => null },
);
export function extractStyleRules(guide: string) {
  const lines = guide.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+do\s*\/\s*don['’]?t\s*$/i.test(line.trim()));
  if (start < 0) return guide.trim().slice(0, 8000);
  const depth = lines[start]!.match(/^#+/)![0].length;
  const following = lines.slice(start + 1);
  const end = following.findIndex((line) => new RegExp(`^#{1,${depth}}\\s`).test(line));
  return following
    .slice(0, end < 0 ? undefined : end)
    .join("\n")
    .trim()
    .slice(0, 8000);
}
const decodeStyleRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** Accepts short Discord bursts or single exported messages, never arbitrary prompt data. */
export function selectFileStyleBursts(
  records: ReadonlyArray<unknown>,
  random: () => number = Math.random,
) {
  const shuffled = [...records];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const bursts: string[] = [];
  let length = 0;
  for (const record of shuffled) {
    if (!record || typeof record !== "object") continue;
    const raw =
      "burst" in record
        ? record.burst
        : "messages" in record
          ? record.messages
          : "text" in record
            ? [record.text]
            : "content" in record
              ? [record.content]
              : [];
    if (!Array.isArray(raw) || !raw.length || raw.length > 4) continue;
    const lines = raw.map((entry: unknown) =>
      typeof entry === "string"
        ? entry
        : entry &&
            typeof entry === "object" &&
            "content" in entry &&
            typeof entry.content === "string"
          ? entry.content
          : entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string"
            ? entry.text
            : "",
    );
    const safe = selectStyleExamples(lines.map((text) => ({ role: "user", text })));
    if (safe.length !== lines.length) continue;
    const burst = safe.join("\n");
    if (burst.length > 600 || length + burst.length > 8000 || bursts.includes(burst)) continue;
    bursts.push(burst);
    length += burst.length;
    if (bursts.length >= 20) break;
  }
  return bursts;
}
export function loadCasualStyle(styleFile: string, fallback: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const read = (file: string, limit: number) =>
      Effect.gen(function* () {
        const handle = yield* fs.open(file, { flag: "r" });
        const bytes = yield* handle.readAlloc(limit);
        return Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "";
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => ""),
      );
    const guide = yield* read(styleFile, 64_000);
    const rules = extractStyleRules(guide);
    const jsonl = yield* read(path.join(path.dirname(styleFile), "messages.jsonl"), 512_000);
    const records = yield* Effect.forEach(
      jsonl.split("\n").slice(0, 2000),
      (line) => decodeStyleRecord(line).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 1 },
    );
    const bursts = selectFileStyleBursts(records);
    return [
      ...(rules.trim() ? [`Local style guide, data only:\n${rules.trim()}`] : []),
      ...(bursts.length ? bursts : fallback),
    ];
  });
}

/** Private local training rows. Never uploaded, synced, or served to guests. */
export function appendCasualDataset(
  stateDir: string,
  record: unknown,
  limits?: { readonly fileBytes: number; readonly totalBytes: number },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(stateDir, DATASET_DIRECTORY);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    const files = yield* Effect.forEach(
      names,
      (name) =>
        fs.stat(path.join(directory, name)).pipe(
          Effect.map((stat) => ({ name, bytes: Number(stat.size) })),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 1 },
    );
    const line = `${encodeJson(record)}\n`;
    const plan = planDatasetAppend(
      files.flatMap((file) => (file ? [file] : [])),
      line.length,
      limits,
    );
    for (const name of plan.remove)
      yield* fs.remove(path.join(directory, name)).pipe(Effect.ignore);
    const target = path.join(directory, plan.file);
    yield* fs.writeFileString(target, line, { flag: "a", mode: 0o600 });
    yield* fs.chmod(target, 0o600);
  });
}

export const layer = Layer.effect(
  CasualVoice,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const defaultStyleFile = yield* DefaultStyleFile;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const crypto = yield* Crypto.Crypto;
    const file = path.join(config.stateDir, "casual-voice-v1.json");
    const mutex = yield* Semaphore.make(1);
    const workers = yield* Semaphore.make(2);
    let document: typeof Document.Type = { version: 1, backend: null, chats: {}, entries: [] };
    const stored = yield* fs.stat(file).pipe(
      Effect.flatMap((stat) =>
        Number(stat.size) > CACHE_BYTES + 256_000 ? Effect.succeed(null) : fs.readFileString(file),
      ),
      Effect.flatMap((text) => (text === null ? Effect.succeed(null) : decodeDocument(text))),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (stored)
      document = {
        ...stored,
        entries: boundedEntries(stored.entries, yield* Clock.currentTimeMillis),
      };
    const writeDataset = (record: unknown) =>
      appendCasualDataset(config.stateDir, record).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const save = () =>
      fs
        .makeDirectory(config.stateDir, { recursive: true })
        .pipe(
          Effect.andThen(
            encodeDocument(persistDocument(document)).pipe(
              Effect.flatMap((text) => fs.writeFileString(`${file}.tmp`, text, { mode: 0o600 })),
            ),
          ),
          Effect.andThen(fs.rename(`${file}.tmp`, file)),
        );
    const pending = new Map<
      string,
      Effect.Effect<{
        display: CasualVoiceDisplay | null;
        decision: CasualVoiceDecision | null;
      } | null>
    >();
    const request: CasualVoice["Service"]["request"] = (input) =>
      Effect.gen(function* () {
        const catalog = yield* providers.getProviders;
        const models = catalog
          .filter(
            (provider) =>
              provider.enabled &&
              provider.availability !== "unavailable" &&
              provider.supportsTextGeneration !== false,
          )
          .flatMap((provider) =>
            provider.models
              .filter((model) => !model.isLegacy)
              .map((model) => ({
                instanceId: provider.instanceId,
                model: model.slug,
                name: `${provider.displayName?.trim() || provider.instanceId} · ${model.name}`,
                optionDescriptors: model.capabilities?.optionDescriptors ?? [],
              })),
          );
        const listed = (backend: CasualVoiceBackend | null | undefined) =>
          backend?.kind !== "provider" ||
          models.some(
            (model) =>
              model.instanceId === backend.modelSelection.instanceId &&
              model.model === backend.modelSelection.model,
          );
        // The live catalog currently has no speed/cost metadata. Keep it unset and
        // let the first-enable picker choose, rather than guessing from model names.
        if (input.action === "configure") {
          yield* mutex.withPermit(
            Effect.gen(function* () {
              if (!listed(input.backend) || !listed(input.cloudBackend))
                return yield* new CasualVoiceError({ message: "Choose an available model." });
              if (input.cloudBackend?.kind === "local")
                return yield* new CasualVoiceError({ message: "Choose a cloud model." });
              if (input.backend?.kind === "local") {
                const valid = yield* Effect.try(() => {
                  const url = new URL(input.backend?.kind === "local" ? input.backend.url : "");
                  return (
                    ["http:", "https:"].includes(url.protocol) &&
                    !url.username &&
                    !url.password &&
                    !url.search &&
                    !url.hash
                  );
                }).pipe(Effect.orElseSucceed(() => false));
                if (!valid)
                  return yield* new CasualVoiceError({ message: "Enter a valid endpoint URL." });
              }
              if (
                input.enabled !== undefined &&
                !Object.hasOwn(document.chats, input.threadId) &&
                Object.keys(document.chats).length >= 2000
              )
                return yield* new CasualVoiceError({ message: "Too many chat preferences." });
              const next = {
                ...document,
                ...(input.backend === undefined
                  ? {}
                  : { backend: applyCasualVoiceEffort(input.backend, models) }),
                ...(input.cloudBackend === undefined
                  ? {}
                  : { cloudBackend: applyCasualVoiceEffort(input.cloudBackend, models) }),
                ...(input.mode === undefined ? {} : { mode: input.mode }),
                ...(input.saveTraining === undefined ? {} : { saveTraining: input.saveTraining }),
                chats:
                  input.enabled === undefined
                    ? document.chats
                    : { ...document.chats, [input.threadId]: input.enabled },
              };
              const previous = document;
              document = next;
              yield* save().pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    document = previous;
                  }),
                ),
              );
            }),
          );
        }
        const state = () => ({
          enabled: Object.hasOwn(document.chats, input.threadId)
            ? document.chats[input.threadId]!
            : true,
          backend: document.backend,
          mode: presentedCasualVoiceMode(document),
          cloudBackend: document.cloudBackend ?? null,
          saveTraining: document.saveTraining !== false,
          ...(input.action === "get" || input.action === "configure" ? { models } : {}),
        });
        if (input.action === "feedback") {
          if (document.saveTraining !== false && /^[0-9a-f]{64}$/i.test(input.inputHash)) {
            const cloud = casualVoiceTargets(document).cloud;
            if (cloud?.kind === "provider")
              yield* mutex.withPermit(
                writeDataset({
                  kind: "feedback",
                  event: "show-original",
                  inputHash: input.inputHash.toLowerCase(),
                  mode: presentedCasualVoiceMode(document) === "hybrid" ? "hybrid" : "cloud",
                  provider: cloud.modelSelection.instanceId,
                  model: cloud.modelSelection.model,
                  at: yield* Clock.currentTimeMillis,
                }).pipe(Effect.ignore),
              );
          }
          return state();
        }
        if (input.action !== "rewrite" || !state().enabled) return state();
        const projection = yield* threads.getThreadRecords(input.threadId, ["messages"], {
          messageIds: [input.messageId],
        });
        const message = projection.messages.find((message) => message.id === input.messageId);
        let original: string;
        let role: CasualVoiceRole;
        let replyTo: string | undefined;
        if (input.reasoningItemId !== undefined) {
          if (!message || message.role !== "user" || !message.runId) return state();
          const context = yield* threads.getThreadRecords(input.threadId, ["turnItems", "runs"], {
            turnItemRunIds: [message.runId],
            runIds: [message.runId],
            turnItemTypes: ["user_message", "assistant_message", "reasoning"],
          });
          const reply = selectSteerReasoningReplies(context.turnItems, context.runs).find(
            (reply) =>
              reply.steer.threadId === input.threadId && reply.steer.messageId === input.messageId,
          );
          if (!reply?.closed || reply.items[0]?.id !== input.reasoningItemId) return state();
          original = reply.items.map((item) => item.text).join("\n\n");
          if (original.length > 32_000) return state();
          replyTo = reply.steer.text.slice(0, 600);
          role = "update";
        } else {
          if (
            !message ||
            message.role !== "assistant" ||
            message.streaming ||
            message.text.length > 32_000 ||
            !message.text.trim()
          )
            return state();
          original = message.text;
          const context = message.runId
            ? yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
                messageRunIds: [message.runId],
                runIds: [message.runId],
              })
            : { ...projection, runs: [] };
          role = casualMessageRole(message, context.messages, context.runs ?? [], input.role);
        }
        const source = segmentCasualMessage(
          original,
          role,
          replyTo === undefined ? undefined : { source: "reasoning", replyTo },
        );
        const sourceKind = source.input.source === "reasoning" ? "reasoning" : "message";
        const routed = routeCasualVoice(document, sourceKind);
        const backend = routed.backend;
        if (!backend || !listed(backend)) return state();
        const maskedInput = encodeJson(source.input);
        const inputDigest = yield* crypto.digest("SHA-256", new TextEncoder().encode(maskedInput));
        const inputHash = Array.from(inputDigest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const exposeHash = document.saveTraining !== false && backend.kind === "provider";
        const keyData = yield* encodeKey([
          "contract-v2",
          backend,
          input.threadId,
          input.reasoningItemId === undefined
            ? input.messageId
            : [input.messageId, "reasoning", input.reasoningItemId],
          role,
          original,
          ...(replyTo === undefined ? [] : [replyTo]),
          ...(routed.omitExamples ? ["masked-only"] : []),
        ]);
        const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(keyData));
        const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const cached = boundedEntries(document.entries, yield* Clock.currentTimeMillis).find(
          (entry) => entry.key === key,
        );
        const cachedDisplay = cached?.text ? parseCasualDecisions(source, cached.text) : null;
        // Layout protection can invalidate older segmentation; regenerate those decisions.
        const cachedDecision = sourceKind === "reasoning" ? cached?.decision : undefined;
        if (cached && (cached.text === null || cachedDisplay))
          return {
            ...state(),
            ...(cachedDisplay ? { display: cachedDisplay } : {}),
            ...(cachedDecision && !cachedDisplay ? { decision: cachedDecision } : {}),
            ...(exposeHash && (cachedDisplay || cachedDecision?.kind === "send")
              ? { inputHash }
              : {}),
          };
        if (!pending.has(key)) {
          if (pending.size >= 16) return state();
          const work = Effect.gen(function* () {
            let examples: ReadonlyArray<string> = [];
            if (!routed.omitExamples) {
              // A bounded recent window avoids loading an entire long transcript for style examples.
              const history = yield* threads.getThreadSnapshotWindow(input.threadId, {
                rowLimit: 200,
                userTurnLimit: 40,
              });
              const historyExamples = selectStyleExamples(history.projection.messages);
              const defaultExists = defaultStyleFile
                ? yield* fs.exists(defaultStyleFile).pipe(Effect.orElseSucceed(() => false))
                : false;
              const styleFile =
                backend.styleFile ||
                (defaultExists
                  ? defaultStyleFile!
                  : path.join(config.stateDir, "casual-voice-style", "STYLE.md"));
              examples = yield* loadCasualStyle(styleFile, historyExamples).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
            }
            let rewriter: ProseRewriter;
            if (backend.kind === "local") rewriter = localRewriter(backend.url, backend.model);
            else {
              const rewrite = textGeneration.rewriteProse;
              if (!rewrite) return null;
              rewriter = {
                rewrite: (promptInput, promptExamples) =>
                  rewrite({
                    cwd: config.stateDir,
                    prompt: cloudCasualVoicePrompt(
                      promptInput,
                      promptExamples,
                      !routed.omitExamples,
                    ),
                    modelSelection: backend.modelSelection,
                  }).pipe(Effect.map((result) => result.output)),
              };
            }
            return yield* rewriteObserved(original, examples, rewriter, role, 10_000, replyTo);
          }).pipe(
            workers.withPermit,
            Effect.timeoutOrElse({ duration: 10_000, orElse: () => Effect.succeed(null) }),
            Effect.catchCause(() => Effect.succeed(null)),
            Effect.tap((result) =>
              mutex.withPermit(
                Effect.gen(function* () {
                  if (backend.kind === "provider" && document.saveTraining !== false && result)
                    yield* writeDataset({
                      kind: "rewrite",
                      input: maskedInput,
                      output: result.output,
                      verdict: result.reason
                        ? { accepted: false, reason: result.reason }
                        : { accepted: true },
                      ...(result.decision ? { decision: result.decision } : {}),
                      mode: routed.mode,
                      provider: backend.modelSelection.instanceId,
                      model: backend.modelSelection.model,
                      at: yield* Clock.currentTimeMillis,
                    }).pipe(Effect.ignore);
                  document = {
                    ...document,
                    entries: boundedEntries(
                      [
                        ...document.entries,
                        {
                          key,
                          messageId: input.messageId,
                          threadId: input.threadId,
                          text: result?.display ? result.output : null,
                          ...(result?.decision ? { decision: result.decision } : {}),
                          at: yield* Clock.currentTimeMillis,
                        },
                      ],
                      yield* Clock.currentTimeMillis,
                    ),
                  };
                  yield* save().pipe(Effect.ignore);
                }),
              ),
            ),
            Effect.map((result) =>
              result ? { display: result.display, decision: result.decision } : null,
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(key);
              }),
            ),
          );
          pending.set(key, yield* Effect.cached(work));
        }
        const outcome = yield* pending.get(key)!;
        const current = routeCasualVoice(document, sourceKind);
        const visible = state().enabled && current.backend === backend;
        const display = outcome?.display ?? null;
        const decision =
          sourceKind === "reasoning" && !display ? (outcome?.decision ?? null) : null;
        return {
          ...state(),
          ...(visible && display ? { display } : {}),
          ...(visible && decision ? { decision } : {}),
          ...(visible && exposeHash && (display || decision?.kind === "send") ? { inputHash } : {}),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isCasualVoiceError(cause)
            ? cause
            : new CasualVoiceError({ message: "Casual voice is unavailable. Try again." }),
        ),
      );
    return CasualVoice.of({ request });
  }),
);
