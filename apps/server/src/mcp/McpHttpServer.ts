import * as ProjectService from "../project/ProjectService.ts";
import * as XPostReader from "../xPost/XPostReader.ts";
import * as XSearch from "../xPost/XSearch.ts";
import { XPostToolkit } from "./toolkits/xPost/tools.ts";
import * as XPostHandlers from "./toolkits/xPost/handlers.ts";
import { presentXPost } from "./toolkits/xPost/result.ts";
import { DebugToolkit } from "./toolkits/debug/tools.ts";
import { WorkflowToolkit } from "./toolkits/workflows/tools.ts";
import * as WorkflowHandlers from "./toolkits/workflows/handlers.ts";
import * as DebugHandlers from "./toolkits/debug/handlers.ts";
import { ModelPreferencesToolkit } from "./toolkits/modelPreferences/tools.ts";
import * as ModelPreferencesHandlers from "./toolkits/modelPreferences/handlers.ts";
import * as ModelPreferences from "../provider/ModelPreferences.ts";
import * as ComputerUseService from "../computer/ComputerUseService.ts";
import * as ComputerHandlers from "./toolkits/computer/handlers.ts";
import {
  ComputerScreenshotTool,
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
} from "./toolkits/computer/tools.ts";
import { advertisedJsonSchema, advertisedOutputSchema } from "./advertisedJsonSchema.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, type Toolkit } from "effect/ai";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import {
  ComputerUseError,
  DeviceToolError,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as BrowserObservations from "../preview/BrowserObservations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import * as AgentToolPolicy from "./AgentToolPolicy.ts";
import {
  agentToolListVisible,
  callerReadsGeminiSchemas,
  rewriteToolsListBody,
  type ToolsListTransform,
  withGeminiSafeEnums,
  withoutGrades,
  toolsListRequestIds,
} from "./AgentToolCatalog.ts";

import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpLiveNotifications from "./McpLiveNotifications.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { UsageLimitsResult } from "./OrchestratorUsageLimits.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectListToolkit, ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { PendingRequestToolkit, ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as QaSandbox from "../preview/QaSandbox.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import * as MonitorMcpService from "./MonitorMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlPreviewTool, HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { MCP_HTTP_PATH } from "../httpCors.ts";

/** Where an MCP client discovers how to sign in (RFC 9728), at this request's own origin. */
const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/**
 * Agents SSHCode launched carry a registry token and must never be sent into
 * an OAuth flow when it dies: they cannot open a browser, and a sign-in
 * would mint a credential that outlives their session. Only a request that
 * does not look like a provider token is pointed at the OAuth metadata.
 */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid SSHCode MCP credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

/**
 * Resolves a bearer token that is not a provider-session token: an OAuth
 * client signed in from outside T3. Undefined when the token is not one.
 */
export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("t3/mcp/McpHttpServer/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

/**
 * Hide tools the caller's policy and credential cannot use. Effect's own
 * `tools/list` does not see the HTTP caller, so the filter runs on the
 * response. A client that cached an older list is still refused at `tools/call`.
 */
const filterToolsListResponse = (
  response: HttpServerResponse.HttpServerResponse,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const ids = toolsListRequestIds(raw);
    if (ids === undefined) return response;
    const current = yield* AgentToolPolicy.currentAgentToolPolicyState;
    if (!current.available) {
      // An error must not replace a client's cached catalog with an empty list.
      return HttpServerResponse.text("SSHCode tool settings are temporarily unavailable.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    const policy = current.policy;
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ChatControls.make().store,
    );
    const visible = (name: string) => agentToolListVisible(policy, name, scope, chatControls);
    // Settings' grading switch: off removes the `grades` input, so it costs nothing.
    const transforms = [
      ...(current.grading ? [] : [withoutGrades]),
      ...(callerReadsGeminiSchemas(current.providerInstances, scope.thread?.providerInstanceId)
        ? [withGeminiSafeEnums]
        : []),
    ];
    const transform: ToolsListTransform | undefined =
      transforms.length === 0
        ? undefined
        : (tool) => transforms.reduce((next, apply) => apply(next), tool);
    const rewrite = (text: string) => rewriteToolsListBody(text, ids, visible, transform);
    const body = response.body;
    if (body._tag === "Uint8Array") {
      const text = body.text ?? new TextDecoder().decode(body.body);
      const next = rewrite(text);
      if (next === text) return response;
      return HttpServerResponse.setBody(response, HttpBody.text(next, body.contentType));
    }
    if (body._tag === "Stream") {
      // Each chunk is one frame. A JSON message split across chunks is left intact.
      const decoder = new TextDecoder();
      return HttpServerResponse.setBody(
        response,
        HttpBody.stream(
          Stream.map(body.stream, (chunk) => {
            const text = decoder.decode(chunk);
            const next = rewrite(text);
            return next === text ? chunk : Buffer.from(next);
          }),
          body.contentType,
        ),
      );
    }
    return response;
  });

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

/**
 * GET SSE needs `text/event-stream`. POST still requires JSON as well; the
 * official client asks for only the event stream on the idle GET.
 * A `q=0` parameter rejects that type, matching Effect's POST media-type check.
 */
const acceptsEventStream = (header: string | undefined): boolean => {
  if (header === undefined) return false;
  return header.split(",").some((part) => {
    const [mediaType, ...parameters] = part.split(";");
    if (mediaType?.trim().toLowerCase() !== "text/event-stream") return false;
    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.slice(2));
    return Number.isFinite(value) && value > 0 && value <= 1;
  });
};

const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const live = yield* McpLiveNotifications.McpLiveNotifications;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The transport allows no browser Origin; refuse it before credentials, as the MCP spec requires.
    if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 });
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      // Without this the only symptom of a dead credential is the agent
      // quietly losing the whole `t3-code` toolkit for the rest of its
      // session, with nothing on the server to explain why.
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
      });
    }
    // FindMyWay rejects a second GET /mcp, and Effect already registered one
    // that returns 405. Auth runs before that handler, so the idle stream
    // replaces it here. PUT, PATCH, and OPTIONS stay on Effect's 405, whose
    // Allow header remains "POST, DELETE".
    if (request.method === "GET") {
      if (!acceptsEventStream(request.headers.accept)) {
        return HttpServerResponse.empty({ status: 406 });
      }
      return yield* live
        .listen({
          sessionId: request.headers["mcp-session-id"],
          protocolVersion: request.headers["mcp-protocol-version"],
          scope: invocation,
        })
        .pipe(
          Effect.map((stream) =>
            HttpServerResponse.stream(stream.events, {
              contentType: "text/event-stream",
              headers: {
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "mcp-session-id": stream.sessionId,
                "mcp-protocol-version": stream.protocolVersion,
              },
            }),
          ),
          Effect.catchTags({
            McpListenMissingSession: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 400 })),
            McpListenUnknownSession: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 404 })),
            McpListenAlreadyAttached: () =>
              Effect.succeed(HttpServerResponse.empty({ status: 409 })),
            McpListenProtocolMismatch: () =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                      code: McpSchema.HEADER_MISMATCH_ERROR_CODE,
                      message:
                        "MCP-Protocol-Version header does not match negotiated protocol version",
                    },
                  },
                  { status: 400 },
                ),
              ),
          }),
        );
    }

    // Effect does not bind a session id to the credential that initialized it.
    // Refuse a foreign namespace or environment before POST or DELETE reaches
    // that handler, so it cannot drop the owner's idle listener.
    const presentedSession = request.headers["mcp-session-id"];
    if (
      (request.method === "POST" || request.method === "DELETE") &&
      presentedSession !== undefined &&
      presentedSession.length > 0
    ) {
      const access = yield* live.authorizeExistingSession({
        sessionId: presentedSession,
        scope: invocation,
      });
      if (access === "foreign") {
        return HttpServerResponse.empty({ status: 404 });
      }
    }

    // Settings are captured when this middleware is built and supplied to the
    // request. A failed read must stay inside `filterToolsListResponse` so
    // tools/list returns 503 instead of an empty catalog.
    const authenticated = Effect.gen(function* () {
      const response = yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
      // Effect adds mcp-session-id inside initialize, after this effect returns,
      // via appendPreResponseHandlerUnsafe. Appending ours now runs second and
      // sees that header. Headers are lowercase.
      yield* HttpEffect.appendPreResponseHandler((_request, next) => {
        if (next.status < 200 || next.status >= 300) return Effect.succeed(next);
        const sessionId = next.headers["mcp-session-id"];
        if (sessionId === undefined || sessionId.length === 0) return Effect.succeed(next);
        return live
          .bindInitializedSession({
            sessionId,
            protocolVersion: next.headers["mcp-protocol-version"] ?? "2025-06-18",
            scope: invocation,
          })
          .pipe(Effect.as(next));
      });
      if (request.method === "DELETE" && response.status === 204) {
        const sessionId = request.headers["mcp-session-id"];
        if (sessionId !== undefined && sessionId.length > 0) {
          yield* live.endSession(sessionId);
        }
      }
      return yield* filterToolsListResponse(response, invocation).pipe(
        Effect.map(normalizeMcpHttpResponse),
      );
    });
    return yield* authenticated.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full
 * accessibility tree and page text loses its locators too. Claude Code also
 * shows the model `structuredContent` in place of the text blocks when a
 * result has both, so both carry the same bounded snapshot. Keep it near
 * 20 KB and tell the agent what was cut. The short `omitted` notes may go a
 * little over; the provider limit is far above this.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const crypto = yield* Crypto.Crypto;
  // Two saves in the same millisecond must not overwrite each other.
  const unique = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  // Parameter errors describe the agent's own input, such as a maxChars over the limit.
  const message =
    isPreviewAutomationError(firstFailure) || AiError.isAiError(firstFailure)
      ? firstFailure.message
      : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const qa = yield* QaSandbox.QaSandbox;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const built = yield* PreviewSnapshotToolkit;
  const observations = yield* BrowserObservations.BrowserObservations;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    // preview_snapshot is registered by hand, so the policy gate has to sit here
    // rather than in registerImageTool. A denial returns before the broker.
    handle: (payload) =>
      AgentToolPolicy.refuseUnavailableAgentTool(tool.name).pipe(
        Effect.flatMap((denied) => {
          if (denied !== undefined) return Effect.succeed(denied);
          return Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            return built.handle("preview_snapshot", payload).pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
              Effect.provideService(QaSandbox.QaSandbox, qa),
              Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.flatMap(({ encodedResult }) =>
                Effect.gen(function* () {
                  const snapshot = encodedResult as PreviewAutomationSnapshot;
                  const { screenshot } = snapshot;
                  const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
                  const screenshotPath =
                    payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
                  // Images stay out of tool history unless asked for: providers replay them on every
                  // later request, and some reject inline images outright.
                  const includeImage = payload?.includeImage === true;
                  if (screenshotPath !== undefined && !includeImage) {
                    // The agent only wants a file to show the user. The url keeps the site icon on the tool row.
                    const saved = {
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                      screenshotPath,
                    };
                    return new McpSchema.CallToolResult({
                      isError: false,
                      structuredContent: saved,
                      content: [{ type: "text", text: encodeJsonText(saved) }],
                    });
                  }
                  const observation = yield* observations.observe(
                    invocation.requestNamespace,
                    snapshot,
                    payload ?? {},
                  );
                  const metadata = {
                    ...observation,
                    ...(screenshotPath === undefined ? {} : { screenshotPath }),
                    ...(includeImage
                      ? {
                          screenshot: {
                            mimeType: screenshot.mimeType,
                            width: screenshot.width,
                            height: screenshot.height,
                          },
                        }
                      : {}),
                  };
                  return new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: encodeJsonText(metadata) },
                      ...(includeImage
                        ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
                        : []),
                    ],
                  });
                }),
              ),
              Effect.provide(saveServices),
              Effect.matchCauseEffect({
                onFailure: previewSnapshotFailure,
                onSuccess: Effect.succeed,
              }),
            );
          });
        }),
      ),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png" | "image/jpeg";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag unless the tool describes them: the remote
 * message may carry renderer or device output the agent should not see, and
 * the tag is what it can act on. A describer returns a server-built message.
 */
const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const message =
      typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error);
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string | ((error: E) => string),
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: advertisedJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        AgentToolPolicy.refuseUnavailableAgentTool(tool.name).pipe(
          Effect.flatMap((denied) => {
            if (denied !== undefined) return Effect.succeed(denied);
            return Effect.withFiber((fiber) => {
              const invocation = Context.getUnsafe(
                fiber.context,
                McpInvocationContext.McpInvocationContext,
              );
              return provide(handle(payload as Tool.Parameters<T>)).pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.matchCauseEffect({
                  onFailure: imageToolFailure(tool.name, operation, failureText),
                  onSuccess: ({ encodedResult }) => {
                    const { screenshot, ...rest } = encodedResult as ImageToolResult;
                    const includeImage =
                      (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                      false;
                    const metadata = {
                      ...rest,
                      screenshot: {
                        mimeType: screenshot.mimeType,
                        width: screenshot.width,
                        height: screenshot.height,
                      },
                    };
                    return Effect.succeed(
                      new McpSchema.CallToolResult({
                        isError: false,
                        structuredContent: metadata,
                        content: [
                          { type: "text", text: JSON.stringify(metadata) },
                          ...(includeImage
                            ? [
                                {
                                  type: "image" as const,
                                  data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                                  mimeType: screenshot.mimeType,
                                },
                              ]
                            : []),
                        ],
                      }),
                    );
                  },
                }),
              );
            });
          }),
        ),
    });
  });

const isDeviceToolError = Schema.is(DeviceToolError);

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "screenshot",
    (error) =>
      isDeviceToolError(error) || isOrchestratorMcpFailure(error)
        ? error.message
        : "Device screenshot failed.",
  );
});

const isComputerUseError = Schema.is(ComputerUseError);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const registerComputerScreenshot = Effect.fn("McpHttpServer.registerComputerScreenshot")(
  function* () {
    const computer = yield* ComputerUseService.ComputerUseService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const built = yield* ComputerScreenshotToolkit;
    yield* registerImageTool(
      ComputerScreenshotTool,
      (payload) =>
        built
          .handle("computer_screenshot", payload)
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
      (effect) =>
        effect.pipe(
          Effect.provideService(ComputerUseService.ComputerUseService, computer),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      "screenshot",
      (error) =>
        isComputerUseError(error) || isOrchestratorMcpFailure(error)
          ? error.message
          : "Computer screenshot failed.",
    );
  },
);

const registerHtmlPreview = Effect.fn("McpHttpServer.registerHtmlPreview")(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* HtmlPreviewToolkit;
  yield* registerImageTool(
    HtmlPreviewTool,
    (payload) =>
      built
        .handle("html_preview", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(HtmlRender.HtmlRender, htmlRender),
        Effect.provideService(ProjectService.ProjectService, projects),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "preview",
    // Parameter errors and HTML render errors are both written by the server for the agent.
    (error) =>
      isOrchestratorMcpFailure(error) || AiError.isAiError(error)
        ? error.message
        : "HTML preview failed.",
  );
});

/**
 * Register handlers that declared their access (see `McpToolAccess`), using
 * Effect's normal schemas and failure serialization with optional result presentation.
 * Every toolkit on `/mcp` registers through this.
 *
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
  presentResult?: (
    toolName: string,
    result: McpSchema.CallToolResult,
  ) => string | McpSchema.CallToolResult | undefined,
) => {
  const isCallToolResult = Schema.is(McpSchema.CallToolResult);
  const registration = Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* McpServer.registerToolkit(toolkit).pipe(
        Effect.provideService(McpServer.McpServer, {
          ...server,
          addTool: (entry) => {
            const source = toolkit.tools[entry.tool.name];
            return server.addTool({
              ...entry,
              tool: new McpSchema.Tool({
                ...entry.tool,
                inputSchema:
                  source === undefined ? entry.tool.inputSchema : advertisedJsonSchema(source),
                ...(entry.tool.outputSchema === undefined
                  ? {}
                  : { outputSchema: advertisedOutputSchema(entry.tool.outputSchema) }),
              }),
              handle: (payload) =>
                AgentToolPolicy.refuseUnavailableAgentTool(entry.tool.name).pipe(
                  Effect.flatMap((denied) => {
                    if (denied !== undefined) return Effect.succeed(denied);
                    return entry.handle(payload).pipe(
                      Effect.map((result) => {
                        if (
                          presentResult === undefined ||
                          !isCallToolResult(result) ||
                          result.isError
                        )
                          return result;
                        const summary = presentResult(entry.tool.name, result);
                        return summary === undefined
                          ? result
                          : typeof summary !== "string"
                            ? summary
                            : new McpSchema.CallToolResult({
                                ...result,
                                content: [...result.content, { type: "text", text: summary }],
                              });
                      }),
                    );
                  }),
                ),
            });
          },
        }),
      );
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

/** A hand-registered tool, also only with handlers that declared their access. */
const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => Layer.effectDiscard(register).pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));

export const layerHtmlToolkit = Layer.mergeAll(
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
).pipe(Layer.provide(HtmlRender.layer));

const layerPreviewStandardToolkitRegistration = toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
);

const layerPreviewSnapshotRegistration = imageToolRegistration(
  registerPreviewSnapshot(),
  PreviewHandlers.layerSnapshot,
);

// One set of observations, so an action diffs against the caller's latest snapshot.
export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
).pipe(Layer.provide(BrowserObservations.layer));

const isUsageLimitsResult = Schema.is(UsageLimitsResult);

function usageLimitsSummary(
  toolName: string,
  result: McpSchema.CallToolResult,
): string | undefined {
  if (toolName !== "usage_limits" || !isUsageLimitsResult(result.structuredContent)) return;
  const report = result.structuredContent;
  const lines = [
    ...report.providers.map((provider) => provider.summary),
    ...report.sources.flatMap((source) => [
      ...source.accounts.map((account) => account.summary),
      ...(source.credits
        ? [
            `${source.displayName}: $${source.credits.dollars.toFixed(2)} left, ${source.credits.defaultHours.toFixed(1)} default-hours / ${source.credits.largeHours.toFixed(1)} large-hours${source.credits.low ? "; low credits" : ""}`,
          ]
        : []),
      ...(source.unavailable ? [`${source.displayName}: unavailable (${source.unavailable})`] : []),
    ]),
  ];
  return lines.join("\n") || "No cached usage limits reported.";
}

const layerModelPreferencesToolkit = toolkitRegistration(
  ModelPreferencesToolkit,
  ModelPreferencesHandlers.layer,
).pipe(Layer.provide(ModelPreferences.layer));

export const layerOrchestratorToolkit = toolkitRegistration(
  OrchestratorToolkit,
  OrchestratorHandlers.layer,
  usageLimitsSummary,
).pipe(
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(ThreadMetadataMcpService.layer),
  Layer.provide(MonitorMcpService.layer.pipe(Layer.provide(ThreadCommandExecutor.layer))),
);

export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer);
export const layerPendingRequestToolkit = toolkitRegistration(
  PendingRequestToolkit,
  ThreadHandlers.layerPendingRequests,
);

const layerWorktreeToolkitRegistration = toolkitRegistration(
  WorktreeToolkit,
  WorktreeHandlers.layer,
).pipe(Layer.provide(WorktreeMcpService.layer));

const layerPreviewControlsRegistration = toolkitRegistration(
  PreviewControlsToolkit,
  PreviewControlsHandlers.layer,
);

export const layerEnvironmentToolkit = toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(Layer.provide(ThreadCommandExecutor.layer));

const layerProjectRegistration = toolkitRegistration(ProjectToolkit, ProjectHandlers.layer);
export const layerProjectListToolkit = toolkitRegistration(
  ProjectListToolkit,
  ProjectHandlers.layerProjectList,
);

export const layerAttachmentToolkit = toolkitRegistration(
  AttachmentToolkit,
  AttachmentHandlers.layer,
);

export const layerPullRequestsToolkit = toolkitRegistration(
  PullRequestsToolkit,
  PullRequestsHandlers.layer,
);

const layerDeviceStandardToolkitRegistration = toolkitRegistration(
  DeviceStandardToolkit,
  DeviceHandlers.layerStandard,
);

const layerDeviceScreenshotRegistration = imageToolRegistration(
  registerDeviceScreenshot(),
  DeviceHandlers.layerScreenshot,
);

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

const layerComputerToolkit = Layer.mergeAll(
  toolkitRegistration(ComputerStandardToolkit, ComputerHandlers.layerStandard),
  imageToolRegistration(registerComputerScreenshot(), ComputerHandlers.layerScreenshot),
);

export const layerMcpTransport = McpServer.layerHttp({
  name: "SSHCode",
  version: packageJson.version,
  path: MCP_HTTP_PATH,
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
}).pipe(
  Layer.provide(layerMcpAuthMiddleware),
  // The settings watcher below must publish into the same instance the
  // middleware captured while this layer was built.
  Layer.provideMerge(McpLiveNotifications.layer),
);

export const layerXPostToolkit = toolkitRegistration(
  XPostToolkit,
  XPostHandlers.layer,
  presentXPost,
).pipe(Layer.provide(XPostReader.layer), Layer.provide(XSearch.layer));

const layerDebugToolkit = toolkitRegistration(DebugToolkit, DebugHandlers.layer);
const layerWorkflowToolkit = toolkitRegistration(WorkflowToolkit, WorkflowHandlers.layer);

/** Every T3 tool, including latent application toolkits. */
export const layerAllTools = Layer.mergeAll(
  layerXPostToolkit,
  layerDebugToolkit,
  layerWorkflowToolkit,
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerModelPreferencesToolkit,
  layerThreadToolkit,
  layerAttachmentToolkit,
  layerProjectRegistration,
  layerEnvironmentToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerComputerToolkit,
  layerHtmlToolkit,
);

export const layerAllToolkits = layerAllTools.pipe(Layer.provideMerge(layerMcpTransport));

/**
 * Share the built-in browser and native-device verification across providers,
 * which harnesses cannot provide themselves, and the question tools a parent
 * needs to answer its subagents. Device access remains gated by the
 * environment's device settings and the calling thread's grants.
 */
export const layerAgentTools = Layer.mergeAll(
  layerXPostToolkit,
  layerDebugToolkit,
  layerWorkflowToolkit,
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerModelPreferencesToolkit,
  layerPendingRequestToolkit,
  layerProjectListToolkit,
  layerDeviceToolkit,
  layerComputerToolkit,
);

/**
 * Tell open MCP sessions that the tool list changed.
 *
 * One settings watcher publishes both ways. Effect still notifies clients
 * whose POST is in flight. Idle GET listeners receive the same signal through
 * `McpLiveNotifications`. Turning a tool off is also immediate on the next
 * `tools/call`. Turning one on is visible to the next `tools/list` of the
 * same session, including after reconnect, without a new credential.
 */
const layerAgentToolListNotifications = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const live = yield* McpLiveNotifications.McpLiveNotifications;
    // The HTTP middleware already requires this service. Yielding it here keeps
    // one watcher on that same instance instead of a second subscription.
    const settings = yield* ServerSettings.ServerSettingsService;
    const publishListChanged = server.notifications["notifications/tools/list_changed"]({}).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.andThen(live.publishToolsListChanged),
    );
    yield* settings.streamChanges.pipe(
      Stream.map((value) => JSON.stringify([value.agentToolPolicy ?? null, value.subagentGrading])),
      Stream.changes,
      Stream.runForEach(() => publishListChanged),
      Effect.forkScoped,
    );
    // A per-chat switch hides tools for that session. Waking every session is
    // cheap: each one filters the list by its own thread.
    const subagentChanges = yield* Queue.sliding<void>(1);
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ChatControls.make().store,
    );
    const stopSubagents = chatControls.subscribeSubagentsChanged(() => {
      Queue.offerUnsafe(subagentChanges, undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(stopSubagents));
    yield* Queue.take(subagentChanges).pipe(
      Effect.andThen(() => publishListChanged),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

export const layer = layerAgentToolListNotifications.pipe(
  Layer.provideMerge(layerAgentTools.pipe(Layer.provideMerge(layerMcpTransport))),
);
