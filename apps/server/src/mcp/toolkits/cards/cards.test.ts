import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_AGENT_BEHAVIOR,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { registerAgentBehavior } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { deferMcpCatalog, deferMcpCatalogFor } from "../../DeferredMcpCatalog.ts";
import { withCompactAgentCatalog } from "../../EagerAgentToolCatalog.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as CardHandlers from "./handlers.ts";
import { CardToolkit, cardsAreEager, registerEagerCardsCheck } from "./tools.ts";

const environmentId = EnvironmentId.make("env-card-test");
const threadId = ThreadId.make("thread-card-test");
const projectId = ProjectId.make("project-card-test");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "session-card-test",
  thread: {
    threadId,
    providerSessionId: "session-card-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "card-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "card-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

// Minimal 1x1 valid PNG bytes.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const cardServerLayer = (workspaceRoot: string) =>
  McpHttpServer.toolkitRegistration(CardToolkit, CardHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              workspaceRoot,
            } as never),
          ),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-cards-test-" })),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(NodeServices.layer),
  );

const callShowCard = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "show_card", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect(
  "returns { ok: true } for a valid card and rejects malformed fields with short errors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cards-ws-" });
        yield* Effect.gen(function* () {
          const ok = yield* callShowCard({
            title: "Deploy status",
            subtitle: "Staging cluster",
            tone: "good",
            icon: "check",
            blocks: [
              { text: "All checks passed." },
              { stats: [{ label: "Latency", value: "42ms", delta: "−8ms" }] },
              { progress: { percent: 100, label: "Rollout", eta: "Done" } },
            ],
            actions: [{ label: "Promote", reply: "Promote staging to prod.", style: "primary" }],
          });
          expect(ok.isError).toBe(false);
          expect(ok.structuredContent).toEqual({ ok: true });

          const badBlock = yield* callShowCard({
            title: "Broken",
            blocks: [{ text: "hello", progress: { percent: 50, label: "half" } }],
          });
          expect(badBlock.isError).toBe(true);
          const badText = badBlock.content
            .map((item) => (item.type === "text" ? item.text : ""))
            .join(" ");
          expect(badText).toContain("blocks[0]");
        }).pipe(Effect.provide(cardServerLayer(workspace)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("validates image block paths against workspace and attachments containment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cards-img-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cards-out-" });
      const insideImage = path.join(workspace, "preview.png");
      const insideText = path.join(workspace, "notes.txt");
      const outsideImage = path.join(outside, "secret.png");
      yield* fs.writeFile(insideImage, TINY_PNG);
      yield* fs.writeFileString(insideText, "not an image");
      yield* fs.writeFile(outsideImage, TINY_PNG);

      yield* Effect.gen(function* () {
        const valid = yield* callShowCard({
          title: "Preview",
          blocks: [{ image: { path: "preview.png", alt: "Workspace preview" } }],
        });
        expect(valid.isError).toBe(false);
        expect(valid.structuredContent).toEqual({ ok: true });

        const escaped = yield* callShowCard({
          title: "Escape",
          blocks: [{ image: { path: outsideImage, alt: "Outside" } }],
        });
        expect(escaped.isError).toBe(true);
        const escapedText = escaped.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .join(" ");
        expect(escapedText).toContain("blocks[0].image.path");

        const nonImage = yield* callShowCard({
          title: "Not image",
          blocks: [{ image: { path: "notes.txt", alt: "Text file" } }],
        });
        expect(nonImage.isError).toBe(true);
        const nonImageText = nonImage.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .join(" ");
        expect(nonImageText).toContain("blocks[0].image.path");
      }).pipe(Effect.provide(cardServerLayer(workspace)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("makes show_card eager when Token use is High or for bot chats, deferred otherwise", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => withCompactAgentCatalog({ ...tool }));

    try {
      // Default level, ordinary chat: deferred
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
      registerEagerCardsCheck(() => false);
      expect(cardsAreEager("thread-normal")).toBe(false);

      const deferredList = deferMcpCatalog(tools) as Array<{ name: string; description?: string }>;
      expect(deferredList.some((entry) => entry.name === "show_card")).toBe(false);
      const dispatcher = deferredList.find((entry) => entry.name === "t3_tool");
      expect(dispatcher?.description).toContain("show_card:");

      // Low token use, ordinary chat: deferred
      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "low" }));
      expect(cardsAreEager("thread-normal")).toBe(false);

      // Bot chat via registration hook: always eager even on low/default
      registerEagerCardsCheck((id) => id === "thread-bot-1");
      expect(cardsAreEager("thread-bot-1")).toBe(true);
      expect(cardsAreEager("thread-normal")).toBe(false);

      // High token use: eager for every chat
      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" }));
      expect(cardsAreEager("thread-normal")).toBe(true);

      const eagerList = deferMcpCatalogFor({ low: false, eagerCards: true })(tools) as Array<{
        name: string;
        description?: string;
      }>;
      expect(eagerList.some((entry) => entry.name === "show_card")).toBe(true);
    } finally {
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
      registerEagerCardsCheck(() => false);
    }
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(CardToolkit, CardHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cards-avail-" })),
        Layer.provideMerge(ServerSettings.layerTest({})),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
