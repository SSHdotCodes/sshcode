import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravityAuthMethod,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import { audioMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { GENERIC_MIME_TYPES } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  makeAntigravityStderrHandler,
  makeAntigravityStdoutTransform,
} from "../antigravityAuthSupport.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import packageJson from "../../../package.json" with { type: "json" };
import { normalizeAntigravitySessionUpdate } from "./AntigravityProtocol.ts";

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateEagerly"
  | "cancelBehavior"
  | "clientCapabilities"
  | "clientInfo"
  | "onStderr"
  | "resumeMethod"
  | "transformSessionUpdate"
  | "transformStdout"
> {
  /** Device CLI environment supplied for this provider session. */
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Serve workspace reads; native diff tools own edits. */
  readonly clientFileReads?: boolean;
  readonly clientCapabilities?: AcpSessionRuntime.AcpSessionRuntimeOptions["clientCapabilities"];
  /** Installed version used to choose the ACP client name before initialize. */
  readonly runtimeVersion?: string | null;
  /** ACP `authenticate` method id. Defaults to the personal Google account flow. */
  readonly authMethod?: AntigravityAuthMethod;
}

/** Whether an Antigravity runtime version is at least `minimum`; unparseable is not. */
function isAntigravityReleaseAtLeast(
  version: string | null | undefined,
  minimum: readonly [number, number, number],
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  const parsed = match?.slice(1).map(Number);
  const difference =
    parsed?.map((part, index) => part - minimum[index]!).find((part) => part !== 0) ?? 0;
  return parsed !== undefined && difference >= 0;
}

/** Older runtimes offer non-Gemini models only to allowlisted clients such as Zed. */
export function antigravityClientInfo(version: string | null | undefined) {
  return isAntigravityReleaseAtLeast(version, [1, 5, 1])
    ? { name: "t3-code", title: "SSHCode", version: packageJson.version }
    : { name: "zed", version: "0.0.0" };
}

/** `agy acp` 1.5.0 steers a running turn with the next prompt; the 1.4 harness queues it. */
export const antigravitySteersWithPrompt = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean => isAntigravityReleaseAtLeast(initializeResult.agentInfo?.version, [1, 5, 0]);

/**
 * `agy acp` 1.5.15+ keeps `session/prompt` open across non-daemon background commands,
 * schedule timers, and subagents until that work finishes, then returns combined usage.
 */
export const antigravityKeepsPromptOpenForBackgroundWork = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean => isAntigravityReleaseAtLeast(initializeResult.agentInfo?.version, [1, 5, 15]);

/** Older ACP builds keep the compact eager declarations. */
export const antigravitySupportsMcpDiscovery = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean => isAntigravityReleaseAtLeast(initializeResult.agentInfo?.version, [1, 5, 17]);

export const antigravityMcpDiscoveryInstructions = (catalog: string) =>
  `T3 Code tools. For lazy tools, read the cached schema at Antigravity's MCP path and use call_mcp_tool with server t3-code.\n${catalog}`;

export const antigravityMcpServers: NonNullable<
  AcpSessionRuntime.AcpSessionRuntimeOptions["mapMcpServers"]
> = (servers, agent) =>
  antigravitySupportsMcpDiscovery(agent)
    ? servers.map((server) =>
        server.name === "t3-code"
          ? {
              ...server,
              _meta: {
                ...(Predicate.isObject(server._meta) ? server._meta : {}),
                antigravity: { forceAllToolsEager: false },
              },
            }
          : server,
      )
    : servers;

/** Normal launches reject browser login; only the auth flow supplies `onAuthorizationUrl`. */
export const makeAntigravityAcpRuntime = Effect.fn("makeAntigravityAcpRuntime")(function* (
  input: AntigravityAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: input.authMethod ?? "oauth-personal",
      authenticateEagerly: true,
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      mapMcpServers: antigravityMcpServers,
      clientInfo: antigravityClientInfo(input.runtimeVersion),
      clientCapabilities: {
        ...input.clientCapabilities,
        // Advertising writes swaps the agent's diff edits for whole-file client_edit_file.
        // The explicit fs fields win over anything the caller advertised.
        fs: { readTextFile: input.clientFileReads === true, writeTextFile: false },
        terminal: false,
      },
      transformStdout: makeAntigravityStdoutTransform(
        input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {},
      ),
      onStderr: makeAntigravityStderrHandler(
        input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {},
      ),
      transformSessionUpdate: normalizeAntigravitySessionUpdate,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export function antigravityPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "auto_edit";
    case "auto":
    case "approval-required":
      return "default";
  }
}

/**
 * The agy CLI rejects the managed runtime's `yolo` and `auto_edit`. It stays in `default`, where
 * it asks before acting and T3 answers from the live runtime policy, so permission changes apply
 * on the next turn without a restart.
 */
export function antigravityCliSessionMode(modeId: string): string {
  return modeId === "yolo" || modeId === "auto_edit" ? "default" : modeId;
}

export function antigravityModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/**
 * Resolves the model a turn should run on. A saved selection is reapplied
 * as-is. The provider default alias resolves to `defaultModel` when the
 * account offers it, so T3 can pick a newer model than the one Google marks
 * current. Otherwise the agent's current selection stands.
 */
/** Runtime 1.4 reports thinking as its own option; 1.3 encoded it in the model ID. */
export function antigravityThinkingConfig(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
) {
  const option = configOptions?.find((candidate) => candidate.category === "thought_level");
  return option?.type === "select" ? option : undefined;
}

/**
 * Runtime 1.4 lists `gemini-3.8-flash` where 1.3 listed `gemini-3.8-flash-high`. The agent
 * still accepts the old IDs, so pass them through; the current model may have no thinking option.
 */
function legacyAntigravityFamily(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  model: string,
) {
  return antigravityModelOptions(configOptions)
    .map((option) => option.value)
    .filter((family) => model.startsWith(`${family}-`))
    .toSorted((left, right) => right.length - left.length)[0];
}

function resolveAntigravityModel(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly model: string | null | undefined;
  readonly defaultModel?: string | undefined;
}): string | undefined {
  const modelConfig = input.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) return input.model;
  const options = antigravityModelOptions(input.configOptions);
  return input.defaultModel &&
    (options.some((option) => option.value === input.defaultModel) ||
      legacyAntigravityFamily(input.configOptions, input.defaultModel) !== undefined)
    ? input.defaultModel
    : current;
}

/** Never replace a saved selection with the default returned by a cold resume. */
export const applyAntigravityAcpModelSelection = Effect.fn("applyAntigravityAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setConfigOption"
    >;
    readonly model: string | null | undefined;
    /** Model to select for the provider default alias. See `resolveAntigravityModel`. */
    readonly defaultModel?: string | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelConfig = configOptions.find((option) => option.id === "model");
    const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
    const resolved = resolveAntigravityModel({
      configOptions,
      model: input.model,
      defaultModel: input.defaultModel,
    });
    // The default alias never sends an internal ID. It selects the manifest
    // default when that differs from the agent's current model, and otherwise
    // leaves the agent's choice alone.
    const explicit = Boolean(input.model) && input.model !== ANTIGRAVITY_DEFAULT_MODEL;
    if (resolved === undefined || (!explicit && resolved === current)) return current;
    const options = antigravityModelOptions(configOptions);
    const legacyFamily = options.some((option) => option.value === resolved)
      ? undefined
      : legacyAntigravityFamily(configOptions, resolved);
    if (legacyFamily !== undefined) {
      yield* input.runtime
        .setConfigOption("model", resolved, { allowUnlistedValue: true })
        .pipe(Effect.mapError(input.mapError));
      return legacyFamily;
    }
    if (!options.some((option) => option.value === resolved)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Antigravity model '${resolved}' is unavailable for this Google account. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(resolved).pipe(Effect.mapError(input.mapError));
    return resolved;
  },
);

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
// Formats the bundled SDK's Audio type accepts. Anything else is rejected up front.
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);
const ANTIGRAVITY_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".svelte",
  ".vue",
  ".log",
  ".diff",
  ".patch",
  ".ini",
  ".conf",
]);
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

export type AntigravityMediaSpawner = Pick<
  ChildProcessSpawner.ChildProcessSpawner["Service"],
  "exitCode"
>;

/** agy infers unsupported audio/mp4a-latm, audio/x-aac and audio/x-flac from these suffixes.
 * Its viewer plays all three codecs in MPEG-4. Preserve the original audio packets. */
const prepareViewerAudio = Effect.fn("Antigravity.prepareViewerAudio")(function* (input: {
  readonly path: string;
  readonly extension: string;
  readonly size: number;
  readonly attachmentsDir: string;
  readonly mediaSpawner?: AntigravityMediaSpawner | undefined;
}) {
  const remux = input.extension === ".aac" || input.extension === ".flac";
  if (
    input.size > ANTIGRAVITY_MAX_MEDIA_BYTES ||
    (input.extension !== ".m4a" && !(remux && input.mediaSpawner))
  )
    return input.path;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const dir = yield* fs.makeTempDirectoryScoped({
      directory: input.attachmentsDir,
      prefix: "agy-media-",
    });
    const alias = path.join(dir, "audio.mp4");
    if (remux && input.mediaSpawner) {
      const code = yield* input.mediaSpawner
        .exitCode(
          ChildProcess.make(
            "ffmpeg",
            [
              "-nostdin",
              "-n",
              "-protocol_whitelist",
              "file",
              "-f",
              input.extension.slice(1),
              "-i",
              input.path,
              "-map",
              "0:a:0",
              "-c:a",
              "copy",
              "-strict",
              "experimental",
              "-fs",
              String(MAX_TOTAL_ATTACHMENT_BYTES),
              alias,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(Effect.timeout("15 seconds"));
      if (code !== 0) return input.path;
      const stat = yield* fs.stat(alias);
      if (stat.size === 0n || stat.size >= BigInt(MAX_TOTAL_ATTACHMENT_BYTES)) return input.path;
    } else {
      yield* fs
        .stream(input.path, { bytesToRead: input.size })
        .pipe(Stream.run(fs.sink(alias, { flag: "wx", mode: 0o600 })));
    }
    return alias;
  }).pipe(Effect.orElseSucceed(() => input.path));
});

/**
 * Sends supported uploads as native ACP content. Other files, and native
 * candidates over their limits, reach the agent through the saved path
 * ProviderService puts in the text block.
 */
export const buildAntigravityPrompt = Effect.fn("buildAntigravityPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
  readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
  readonly mediaSpawner?: AntigravityMediaSpawner | undefined;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    const isPastedText =
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text";
    // ProviderService has already put the file path in the text block. Keep a
    // folded clipboard paste lazy so the agent can search or sample it rather
    // than paying to embed the entire resource in context immediately.
    const declared = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const extension = path.extname(attachment.name).toLowerCase();
    const video = attachment.type === "file" ? videoMimeType(attachment) : null;
    const mimeType =
      video ??
      (!declared || GENERIC_MIME_TYPES.has(declared)
        ? (audioMimeTypeFromExtension(extension) ?? declared)
        : declared);
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const audio = attachment.type === "file" && AUDIO_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        TEXT_MIME_TYPES.has(mimeType) ||
        TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
    const isPathOnly =
      (attachment.type === "image" && (!image || input.promptCapabilities?.image !== true)) ||
      (attachment.type === "file" &&
        (isPastedText ||
          (audio
            ? input.promptCapabilities?.audio !== true
            : pdf || textFile
              ? input.promptCapabilities?.embeddedContext !== true
              : true)));
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Invalid attachment '${attachment.name}'.`,
      );
    }
    const info = yield* fileSystem
      .stat(attachmentPath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Could not read attachment '${attachment.name}'.`,
          ),
        ),
      );
    if (info.type !== "File") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Could not read attachment '${attachment.name}'.`,
      );
    }
    const fileUri = (file: string) =>
      path.toFileUrl(file).pipe(
        Effect.map((url) => url.href),
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
        ),
      );
    const size = Number(info.size);
    const media = attachment.type === "file" && (video !== null || mimeType.startsWith("audio/"));
    if (
      media &&
      (isPathOnly ||
        size > ANTIGRAVITY_MAX_MEDIA_BYTES ||
        totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES)
    ) {
      // agy 1.5.16 accepts binary resource blocks but drops their media. Its
      // read_file tool gives Gemini the original video and sound together.
      const mediaPath = mimeType.startsWith("audio/")
        ? yield* prepareViewerAudio({
            path: attachmentPath,
            extension,
            size,
            attachmentsDir: input.attachmentsDir,
            mediaSpawner: input.mediaSpawner,
          })
        : attachmentPath;
      const uri = yield* fileUri(mediaPath);
      blocks.push({
        type: "resource_link",
        uri,
        name: attachment.name,
        mimeType: mediaPath === attachmentPath ? mimeType : "audio/mp4",
      });
      const overLimit =
        size > ANTIGRAVITY_MAX_MEDIA_BYTES
          ? "Over the 20 MiB inline limit. "
          : totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES
            ? "Over the 50 MiB message limit. "
            : "";
      const viewerPath =
        mediaPath === attachmentPath &&
        mimeType.startsWith("audio/") &&
        (extension === ".aac" || extension === ".flac")
          ? `a lossless MP4 remux of ${mediaPath}`
          : mediaPath === attachmentPath && extension === ".m4a"
            ? `a temporary .mp4 copy of ${mediaPath}`
            : mediaPath;
      blocks.push({
        type: "text",
        text: `${overLimit}Use read_file on ${viewerPath} for native media.`,
      });
      continue;
    }
    if (isPathOnly) continue;
    const limit = image
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : audio
        ? ANTIGRAVITY_MAX_MEDIA_BYTES
        : pdf
          ? MAX_TOTAL_ATTACHMENT_BYTES
          : ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES;
    if (
      attachment.type === "file" &&
      (size > limit || totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES)
    ) {
      continue;
    }
    totalBytes += size;
    if (size > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Image '${attachment.name}' is too large. Antigravity accepts images up to 10 MiB and 50 MiB of native attachments per message.`,
      );
    }
    const uri = yield* fileUri(attachmentPath);
    if (pdf) {
      blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType });
      continue;
    }
    const bytes = yield* fileSystem.stream(attachmentPath, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Could not read attachment '${attachment.name}'.`,
        ),
      ),
    );
    totalBytes += bytes.length - size;
    if (bytes.length > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' changed while being read and is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else if (audio) {
      blocks.push({ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else {
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? "UTF-16LE"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "UTF-16BE"
            : "UTF-8";
      const decoded = Option.liftThrowable((data: Uint8Array) =>
        new TextDecoder(encoding, { fatal: true }).decode(data),
      )(bytes);
      // Other encodings and binary data stay path-only so the agent reads them with its own tools.
      if (Option.isNone(decoded) || decoded.value.includes("\0")) {
        totalBytes -= bytes.length;
        continue;
      }
      blocks.push({ type: "resource", resource: { uri, mimeType, text: decoded.value } });
    }
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or supported attachments.",
    );
  }
  return blocks;
});
