import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../../../secrets/ApiKeyStore.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import fixture from "../../../xPost/fixtures/syndication-media.json" with { type: "json" };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  issuedAt: 0,
  requestNamespace: "readonly-client",
  thread: undefined,
  client: { sessionId: "client", label: "Test client", access: "read-only" },
  capabilities: new Set(),
};
const noSavedKey = Layer.mock(ApiKeyStore.ApiKeyStore)({
  shared: () => Effect.succeed(undefined),
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("reads without a thread or approval, returning text first and opt-in MCP images", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes("pbs.twimg.com")
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })
        : new Response(encodeJson(fixture)),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tool = server.tools.find((entry) => entry.tool.name === "read_x_post")?.tool;
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      const plain = yield* server.callTool({
        name: "read_x_post",
        arguments: { url: "1950583566947213444" },
      });
      expect(plain.isError).toBe(false);
      expect(plain.content).toHaveLength(1);
      expect(plain.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("NASA JPL (@NASAJPL)"),
      });
      // The post reaches the model once, as text, under a schema of two strings.
      expect(plain.structuredContent).toEqual({
        url: "https://x.com/NASAJPL/status/1950583566947213444",
        post: (plain.content[0] as { readonly text: string }).text,
      });
      expect(plain.structuredContent).not.toHaveProperty("images");
      const images = yield* server.callTool({
        name: "read_x_post",
        arguments: { url: "1950583566947213444", includeImages: true },
      });
      expect(images.content.map((c) => c.type)).toEqual(["text", "image", "image"]);
      expect(images.content[1]).toMatchObject({
        mimeType: "image/jpeg",
        data: new Uint8Array([1, 2, 3]),
      });
      expect(images.structuredContent).not.toHaveProperty("images");
      const bad = yield* server.callTool({
        name: "read_x_post",
        arguments: { url: "https://x.com.evil.example/a/status/1" },
      });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("numeric post ID"),
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerXPostToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(noSavedKey),
          Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  }),
);

it.effect("searches X for read-only callers and returns the posts once, as text", () =>
  Effect.gen(function* () {
    const queries: string[] = [];
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tool = server.tools.find((entry) => entry.tool.name === "search_x")?.tool;
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      const found = yield* server.callTool({
        name: "search_x",
        arguments: { query: "  from:xai grok  " },
      });
      expect(found.isError).toBe(false);
      expect(found.content).toEqual([{ type: "text", text: "@xai · a post" }]);
      expect(found.structuredContent).toEqual({ posts: "@xai · a post" });
      expect(queries).toEqual(["from:xai grok"]);
      const blank = yield* server.callTool({ name: "search_x", arguments: { query: "  " } });
      expect(blank.isError).toBe(true);
      expect(queries).toHaveLength(1);
    }).pipe(
      Effect.provide(
        McpHttpServer.layerXPostToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(noSavedKey),
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.succeed([
                {
                  enabled: true,
                  xSearch: (query: string) =>
                    Effect.sync(() => {
                      queries.push(query);
                      return "@xai · a post";
                    }),
                } as unknown as ProviderInstance,
              ]),
            }),
          ),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  }),
);
