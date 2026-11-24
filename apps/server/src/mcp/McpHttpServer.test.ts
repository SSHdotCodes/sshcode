import { QaSandbox } from "../preview/QaSandbox.ts";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provide(Layer.mock(QaSandbox)({ touch: () => Effect.void })),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerPullRequestsTest = McpHttpServer.layerPullRequestsToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      NodeServices.layer,
    ),
  ),
);

const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

/** Answers every snapshot request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const events = yield* broker.connect({
          clientId: "mcp-failure-client",
          environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "mcp-failure-client",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "sensitive renderer failure",
                  detail: { consoleOutput: "sensitive browser output" },
                },
              }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const snapshot = yield* server
          .callTool({ name: "preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        const message =
          "Preview automation snapshot failed on client mcp-failure-client. Retry unchanged: no; inspect preview_status first.";
        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: `Preview snapshot failed: ${message}` },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
            message,
          },
        });
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { args: {}, advice: "No active preview tab was found for snapshot. Call preview_open first." },
  {
    args: { tabId: alternateTabId },
    advice: `Preview tab ${alternateTabId} was not found for snapshot. Omit tabId to use the current tab, or call preview_open.`,
  },
])("tells the agent to open a tab when the snapshot has none $args", ({ args, advice }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const events = yield* broker.connect({ clientId: "mcp-no-tab-client", environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Deferred.succeed(connected, undefined)
          : broker.respond({
              clientId: "mcp-no-tab-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: { _tag: "PreviewAutomationTabNotFoundError", message: "no tab" },
            }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const snapshot = yield* callSnapshot(args);

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: `Preview snapshot failed: ${advice}` },
      ]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("tells the agent how to recover when no preview host can run the snapshot", () =>
  Effect.gen(function* () {
    const snapshot = yield* callSnapshot({});

    expect(snapshot.isError).toBe(true);
    const [text] = snapshot.content;
    expect(text?.type === "text" ? text.text : "").toContain(
      "Retry preview_status, then call preview_open",
    );
    expect(snapshot.structuredContent).toMatchObject({
      error: { _tag: "PreviewAutomationNoAvailableHostError" },
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { mode: "default", input: {}, images: false },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({ captureScreenshot: images && requests <= 6 });
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toMatchObject({
          url: page.url,
          title: `Snapshot ${call}`,
          loading: false,
          mode: "compact",
          tabId: alternateTabId,
          tree: expect.stringContaining("Save your changes"),
          snapshotId: expect.any(String),
        });
        const [text, ...rest] = snapshot.content;
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(
          snapshot.structuredContent,
        );
        expect(rest).toEqual(
          images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : [],
        );
      }

      // Output selection belongs to this call, not the MCP session's history.
      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text"]);
      expect(nextDefault.structuredContent).toMatchObject({ title: "Snapshot 7" });
      expect(nextDefault.structuredContent).not.toHaveProperty("screenshot");
      expect(nextDefault.structuredContent).not.toHaveProperty("accessibilityTree");
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses preview tools to a client outside a thread before they run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readOnly = {
      ...invocation,
      thread: undefined,
      requestNamespace: "client:session-1",
      client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    };
    const click = yield* server
      .callTool({ name: "preview_act", arguments: { action: "click", locator: "text=Send" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, readOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(click.isError).toBe(true);
    expect(click.content).toEqual([
      { type: "text", text: expect.stringContaining("needs an agent running inside SSHCode") },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects invalid snapshot options with the reason, before selecting a browser host", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const [argument, value] of [
      ["includeImage", "false"],
      ["includeImage", 0],
      ["includeImage", null],
      ["maxChars", 80_000],
    ] as const) {
      const result = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { [argument]: value },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      // The agent learns which of its own parameters to fix.
      const text = (result.content as ReadonlyArray<{ readonly text: string }>)[0]!.text;
      expect(text).toMatch(/^Preview snapshot failed: /);
      expect(text).toContain(argument);
      expect(result.structuredContent).toEqual({
        error: {
          _tag: "AiError",
          operation: "snapshot",
          failureCount: 1,
          message: text.slice("Preview snapshot failed: ".length),
        },
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves the snapshot PNG on request and reports its path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputs = yield* serveSnapshots("mcp-save-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true, includeImage: true });

      expect(snapshot.isError).toBe(false);
      // The browser never receives the server-only `save` flag.
      expect(inputs).toEqual([{ captureScreenshot: true }]);
      expect(snapshot.content.map((content) => content.type)).toContain("image");
      const structured = snapshot.structuredContent as { readonly screenshotPath?: string };
      const screenshotPath = structured.screenshotPath;
      expect(typeof screenshotPath).toBe("string");
      expect(path.dirname(screenshotPath!)).toBe(config.browserArtifactsDir);
      expect(path.basename(screenshotPath!)).toMatch(
        /^browser-screenshot-example-test-[0-9a-z]+-[0-9a-f]{8}\.png$/,
      );
      expect(Buffer.from(yield* fileSystem.readFile(screenshotPath!)).toString()).toBe("png");
      const [text] = snapshot.content;
      expect(text?.type === "text" ? text.text : "").toContain(screenshotPath);

      const unsaved = yield* callSnapshot({});
      expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");

      // A save without the image skips the page dump.
      const pathOnly = yield* callSnapshot({ save: true });
      const saved = pathOnly.structuredContent as { readonly screenshotPath: string };
      expect(saved).toEqual({ url: snapshotResult.url, screenshotPath: expect.any(String) });
      expect(Buffer.from(yield* fileSystem.readFile(saved.screenshotPath)).toString()).toBe("png");
      const [only, ...others] = pathOnly.content;
      expect(others).toEqual([]);
      expect(only?.type === "text" ? decodeJsonText(only.text) : null).toEqual(saved);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("reports a tagged error when the screenshot cannot be saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A regular file where the artifacts directory should be makes every write fail.
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "registers the pull request toolkit and surfaces a missing capability as a tool error",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "link_pull_request",
          "unlink_pull_request",
          "list_thread_pull_requests",
        ]),
      );
      const linkTool = server.tools.find(({ tool }) => tool.name === "link_pull_request");
      expect(linkTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(linkTool?.tool.annotations?.openWorldHint).toBe(false);
      expect(linkTool?.tool.description).toContain("Register every pull request you open");

      const denied = yield* server
        .callTool({ name: "list_thread_pull_requests", arguments: {} })
        .pipe(
          // A preview-only credential: the token predates the toolkit or was minted elsewhere.
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(layerPullRequestsTest)),
);

it.effect("returns server ARIA refs to agents in text and structured results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree =
        '- button "delete" [ref=t3-snapshot-e1]\n- iframe [ref=t3-snapshot-e2]:\n  - textbox "child" [ref=t3-snapshot-f1e1]';
      yield* serveSnapshots("mcp-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        tree: expect.stringContaining('textbox "child" [ref=t3-snapshot-f1e1]'),
      });
      expect(
        result.content.some(
          (entry) => entry.type === "text" && entry.text.includes("t3-snapshot-f1e1"),
        ),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { operation: "click", tool: "preview_act", refreshFails: false },
  { operation: "click", tool: "preview_act", refreshFails: true },
  { operation: "waitFor", tool: "preview_wait_for", refreshFails: false },
])(
  "returns a compact fresh page for stale refs without repeating $operation (refresh fails: $refreshFails)",
  ({ operation, tool, refreshFails }) =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const operations: string[] = [];
      const events = yield* broker.connect({ clientId: "mcp-stale-ref-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        const { request } = event;
        operations.push(request.operation);
        return broker.respond({
          clientId: "mcp-stale-ref-client",
          connectionId: event.connectionId,
          requestId: request.requestId,
          ...(request.operation === operation
            ? {
                ok: false,
                error: {
                  _tag: "PreviewAutomationInvalidSelectorError",
                  message: "stale",
                  detail: { staleRef: true },
                },
              }
            : refreshFails
              ? {
                  ok: false,
                  error: { _tag: "PreviewAutomationExecutionError", message: "navigation" },
                }
              : {
                  ok: true,
                  result: {
                    ...snapshotResult,
                    tabId,
                    accessibilityTree:
                      '- button "Continue" [ref=fresh-e1]\n' +
                      "- paragraph: filler\n".repeat(1_000),
                  },
                }),
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: tool,
          arguments: {
            tabId,
            ...(operation === "click" ? { action: "click" } : {}),
            locator: "aria-ref=old-e1",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(operations).toEqual([operation, "snapshot"]);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("Stale ref.");
      expect(serialized).toContain("retry unchanged: no");
      if (refreshFails) {
        expect(serialized).toContain("preview_snapshot");
      } else {
        expect(serialized).toContain("fresh-e1");
        expect(serialized).toContain("snapshotId");
        expect(serialized).not.toContain('"type":"image"');
        expect(serialized.length).toBeLessThan(8_000);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("bounds large ARIA trees without dropping every server locator", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree = Array.from(
        { length: 2_000 },
        (_, index) => `- button "删除 ${index}" [ref=t3-snapshot-e${index}]`,
      ).join("\n");
      yield* serveSnapshots("mcp-large-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      const metadata = result.structuredContent as { tree: string };
      expect(metadata.tree).toContain("[ref=t3-snapshot-e0]");
      expect(metadata.tree.length).toBeLessThan(accessibilityTree.length);
      const body = result.content[0];
      expect(Buffer.byteLength(body?.type === "text" ? body.text : "", "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "bounds legacy observations without duplicating page text, AX objects or default logs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oversized = {
          ...snapshotResult,
          visibleText: "Project details\n".repeat(5000),
          interactiveElements: [
            {
              tag: "button",
              role: "button",
              name: "Continue",
              selector: "#continue",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
          ],
          accessibilityTree: {
            nodes: Array.from({ length: 2000 }, (_, i) => ({ nodeId: String(i) })),
          },
          consoleEntries: Array.from({ length: 100 }, () => ({
            level: "log",
            text: "x".repeat(2000),
            timestamp: "t",
          })),
        };
        yield* serveSnapshots("mcp-legacy-bounded", oversized);
        const result = yield* callSnapshot({});
        expect(result.isError).toBe(false);
        const text = result.content[0];
        expect(text?.type).toBe("text");
        const body = text?.type === "text" ? text.text : "";
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
          McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
        );
        expect(decodeJsonText(body)).toEqual(result.structuredContent);
        expect(result.structuredContent).toMatchObject({
          tree: expect.stringContaining("#continue"),
          omitted: expect.any(Array),
        });
        for (const field of [
          "visibleText",
          "interactiveElements",
          "accessibilityTree",
          "consoleEntries",
          "screenshot",
          "diagnostics",
        ])
          expect(result.structuredContent).not.toHaveProperty(field);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("bounds explicit diagnostics while retaining semantic refs and task context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "界".repeat(70000);
      yield* serveSnapshots("mcp-full-logs-client", {
        ...snapshotResult,
        title: long,
        accessibilityTree: '- button "Continue" [ref=t3-page-e1]\n- status: Ready\n' + long,
        consoleEntries: Array.from({ length: 100 }, () => ({
          level: long,
          text: long,
          timestamp: "t",
        })),
        networkEntries: Array.from({ length: 100 }, () => ({
          url: long,
          method: "GET",
          status: 500,
          failed: true,
          errorText: long,
          timestamp: "t",
        })),
        actionTimeline: Array.from({ length: 100 }, () => ({
          id: "a",
          action: long,
          status: "failed",
          startedAt: "t",
          error: long,
        })),
      });
      const result = yield* callSnapshot({ includeDiagnostics: true, maxChars: 20000 });
      expect(result.isError).toBe(false);
      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      expect(decodeJsonText(body)).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({
        tree: expect.stringContaining("t3-page-e1"),
        diagnostics: expect.any(Object),
        omitted: expect.any(Array),
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport.pipe(
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// Why the ACP stdio bridge starts a fresh session for every initialize it relays.
it.effect("rejects an initialize that carries an existing session id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("acpRegistry_kimi"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport.pipe(
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );
      const initialize = (headers: Record<string, string>) =>
        httpClient.post("/mcp", {
          headers: { accept: "application/json, text/event-stream", ...headers },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"kimi","version":"1.0.0"}}}`,
            "application/json",
          ),
        });

      const first = yield* initialize({});
      const sessionId = first.headers["mcp-session-id"];
      expect(first.status).toBe(200);

      const again = yield* initialize({
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-06-18",
      });
      expect(again.status).toBe(400);

      const fresh = yield* initialize({});
      expect(fresh.status).toBe(200);
      expect(fresh.headers["mcp-session-id"]).not.toBe(sessionId);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const toolIcon = {
        _tag: "website" as const,
        pageUrl: "http://example.test/",
      };
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? snapshotResult
              : event.request.operation === "evaluate"
                ? ["Connect", "Continue"]
                : event.request.operation === "press"
                  ? undefined
                  : {
                      available: true,
                      visible: true,
                      tabId,
                      url: "http://example.test/",
                      title: "Example",
                      loading: false,
                    },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_act");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      const validateAction = new AjvJsonSchemaValidator().getValidator(
        clickTool!.tool.outputSchema! as JsonSchemaType,
      );
      expect(validateAction({}).valid).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_act", arguments: { action: "click", selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const routedBeforeInvalid = routedRequests.length;
      for (const arguments_ of [
        { action: "type" },
        { action: "click", x: 10, y: 10, clickCount: 4 },
        { action: "select", locator: "aria-ref=field" },
        { action: "drag", source: "aria-ref=source" },
        { action: "upload" },
        { action: "press" },
      ]) {
        const invalid = yield* server
          .callTool({ name: "preview_act", arguments: arguments_ })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(invalid.isError).toBe(true);
      }
      expect(routedRequests).toHaveLength(routedBeforeInvalid);

      const snapshot = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId, includeImage: true },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"], toolIcon });
      const evaluatedText = evaluated.content[0];
      expect(evaluatedText?.type === "text" ? decodeJsonText(evaluatedText.text) : null).toEqual({
        toolIcon,
        value: ["Connect", "Continue"],
      });

      const actionRequests = [
        { name: "preview_act", arguments: { action: "click", x: 10, y: 10 } },
        { name: "preview_act", arguments: { action: "type", text: "Hello" } },
        { name: "preview_act", arguments: { action: "press", key: "Enter" } },
        { name: "preview_act", arguments: { action: "scroll", deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ toolIcon });
        // An action then looks at its tab for what changed; this tab was never observed.
        expect(routedRequests.at(-1)?.operation).toBe(
          request.name === "preview_act" ? "snapshot" : "status",
        );
        const text = result.content[0];
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual({ toolIcon });
      }

      // On the observed tab, an action reports the page against that snapshot.
      const observedAction = yield* server
        .callTool({
          name: "preview_act",
          arguments: { action: "click", x: 10, y: 10, tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(observedAction.isError).toBe(false);
      expect(observedAction.structuredContent).toMatchObject({
        page: {
          baseSnapshotId: (snapshot.structuredContent as { snapshotId: string }).snapshotId,
          unchanged: true,
        },
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
              Effect.as({ ok: true }),
            ),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
        Layer.provide(ServerHttp.layerBrowserApiCors),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-origin-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');

      // A present, disallowed Origin is refused with 403 before credentials or CORS answer.
      const foreignOrigin = (method: "POST" | "OPTIONS", token: string | undefined) =>
        httpClient.execute(
          HttpClientRequest.make(method)("/mcp", {
            headers: {
              origin: "https://untrusted.invalid",
              accept: "application/json, text/event-stream",
              "access-control-request-method": "POST",
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            ...(method === "POST"
              ? {
                  body: HttpBody.text(
                    `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                    "application/json",
                  ),
                }
              : {}),
          }),
        );
      expect((yield* foreignOrigin("POST", providerToken)).status).toBe(403);
      expect((yield* foreignOrigin("POST", undefined)).status).toBe(403);
      expect((yield* foreignOrigin("OPTIONS", undefined)).status).toBe(403);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "records bounded MCP tool outputs and errors in McpProviderSessions for thread callers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const okTool = Tool.make("delegate_task", {
          description: "Test delegate tool",
          parameters: Schema.Struct({ task: Schema.String }),
          success: Schema.Struct({ taskId: Schema.String, childThreadId: Schema.String }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        });
        const toolkit = Toolkit.make(okTool);
        const handlers = McpToolAccess.toLayer(toolkit, {
          delegate_task: McpToolAccess.reads(({ task }) =>
            task === "fail"
              ? Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "delegation failed",
                  }),
                )
              : Effect.succeed({ taskId: "task-1", childThreadId: "child-1" }),
          ),
        });
        const layer = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provide(ServerSettings.layerTest({})),
        );
        const ctx = yield* Layer.build(layer);
        const server = yield* McpServer.McpServer.pipe(Effect.provide(ctx));
        const sessions = yield* McpProviderSessions.McpProviderSessions.pipe(Effect.provide(ctx));
        const threadInvocation = {
          ...invocation,
          capabilities: new Set(["orchestration"] as const),
        };
        yield* server
          .callTool({ name: "delegate_task", arguments: { task: "review" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        yield* server
          .callTool({ name: "delegate_task", arguments: { task: "fail" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        // External OAuth callers have no thread session and must not record.
        yield* server.callTool({ name: "delegate_task", arguments: { task: "external" } }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...threadInvocation,
            thread: undefined,
            client: { sessionId: "ext-1", label: "External", access: "read-only" as const },
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

        // Two delegate_task results wait: arguments that match neither must not guess one.
        const ambiguous = yield* sessions.takeToolResult(threadId, "delegate_task", {
          task: "reported differently",
        });
        expect(ambiguous).toBeUndefined();
        const okOutput = yield* sessions.takeToolResult(threadId, "delegate_task", {
          task: "review",
        });
        expect(okOutput).toEqual({ taskId: "task-1", childThreadId: "child-1" });
        const errOutput = yield* sessions.takeToolResult(threadId, "delegate_task", {
          task: "fail",
        });
        expect(errOutput).toMatchObject({ isError: true });
        const noneLeft = yield* sessions.takeToolResult(threadId, "delegate_task", {
          task: "external",
        });
        expect(noneLeft).toBeUndefined();
      }),
    ),
);
