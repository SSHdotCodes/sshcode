import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { HtmlToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-html-access");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("html-access"),
  requestNamespace: "html-access",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

it.effect.each([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "guest",
  "share",
  "external",
  "stopped",
  "both",
  "neither",
] as const)("refuses %s path calls before any file or project access", (kind) =>
  Effect.gen(function* () {
    const outside = ["guest", "share", "external"].includes(kind);
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        McpInvocationContext.McpInvocationContext,
        outside
          ? {
              ...scope,
              thread: undefined,
              client:
                kind === "external"
                  ? { sessionId: "external", label: "external", access: "full-access" }
                  : undefined,
            }
          : scope,
      ),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            liveThreadShell(threadId, {
              runtimeMode: ["approval-required", "auto-accept-edits", "auto"].includes(kind)
                ? (kind as RuntimeMode)
                : "full-access",
              ...(kind === "stopped" ? { activeRunId: null } : {}),
            }),
          ),
      }),
      // Missing methods fail if the refusal accidentally reaches either service.
      Layer.mock(HtmlRender.HtmlRender)({}),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    const toolkit = yield* HtmlToolkit.pipe(
      Effect.provide(
        Layer.merge(
          McpToolAccess.HandlersLayer.layer(Handlers.layerPreview),
          McpToolAccess.HandlersLayer.layer(Handlers.layerRender),
        ).pipe(Layer.provide(dependencies)),
      ),
    );
    const input =
      kind === "neither"
        ? {}
        : { path: "/workspace/page.html", ...(kind === "both" ? { html: "<html/>" } : {}) };
    for (const name of ["html_preview", "html_render"] as const) {
      const call = toolkit
        .handle(name, { ...input, title: "Page", height: 240 })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const result =
        name === "html_preview" ? yield* call.pipe(Effect.flip) : (yield* call).at(-1)?.result;
      expect(result).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: outside
          ? "thread_credential_required"
          : kind === "stopped"
            ? "parent_not_active"
            : kind === "both" || kind === "neither"
              ? "invalid_request"
              : "capability_denied",
      });
    }
  }),
);
