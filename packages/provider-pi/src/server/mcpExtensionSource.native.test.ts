// @effect-diagnostics nodeBuiltinImport:off -- Drives the installed Pi CLI against loopback fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { useTempDirs } from "@t3tools/shared/testing/tempDirs";
import { expect, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

const pi = process.env.T3_PI_MCP_TEST_BINARY;
const makeTempDir = useTempDirs();
const functionCall = (name: string, args: Record<string, unknown>) => ({
  tool_calls: [
    {
      index: 0,
      id: `call-${name}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

it.skipIf(!pi)(
  "loads a listed tool through native Pi search and calls it over MCP",
  async () => {
    const cwd = makeTempDir("t3-pi-native-mcp-");
    const modelRequests: unknown[] = [];
    const calls: unknown[] = [];
    const server = NodeHttp.createServer(async (request, response) => {
      request.setEncoding("utf8");
      const chunks: string[] = [];
      for await (const chunk of request) chunks.push(String(chunk));
      const body = JSON.parse(chunks.join("")) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (request.url === "/mcp") {
        const { id, method, params } = body;
        if (id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "t3-code", version: "1" },
              }
            : method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "schedule_task",
                      description: "Schedule a fixture job. Use the provided job details.",
                      inputSchema: {
                        type: "object",
                        properties: { fixtureJobDetails: { type: "string" } },
                        required: ["fixtureJobDetails"],
                      },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "fixture scheduled" }] };
        if (method === "tools/call") calls.push(params);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const index = modelRequests.push(body);
      const delta =
        index === 1
          ? functionCall("tool_search", { query: "schedule_task" })
          : index === 2
            ? functionCall("mcp__t3-code__schedule_task", { fixtureJobDetails: "job" })
            : { content: "done" };
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      });
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify(chunk(delta, null))}\n\n` +
            `data: ${JSON.stringify(chunk({}, index < 3 ? "tool_calls" : "stop"))}\n\n` +
            "data: [DONE]\n\n",
        );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const extension = NodePath.join(cwd, "bridge.ts");
      await Promise.all([
        NodeFSP.writeFile(extension, PI_T3_MCP_EXTENSION_SOURCE),
        NodeFSP.writeFile(
          NodePath.join(cwd, "models.json"),
          JSON.stringify({
            providers: {
              probe: {
                baseUrl: `${origin}/v1`,
                api: "openai-completions",
                apiKey: "fixture",
                models: [{ id: "fixture" }],
              },
            },
          }),
        ),
      ]);
      const running = NodeUtil.promisify(NodeChildProcess.execFile)(
        pi!,
        [
          "--offline",
          "--no-session",
          "--no-skills",
          "--no-context-files",
          "--provider",
          "probe",
          "--model",
          "fixture",
          "--extension",
          extension,
          "--mode",
          "json",
          "-p",
          "Schedule a fixture job.",
        ],
        {
          cwd,
          timeout: 10_000,
          env: {
            HOME: cwd,
            USERPROFILE: cwd,
            PATH: [
              NodePath.dirname(process.execPath),
              NodePath.dirname(pi!),
              "/usr/bin",
              "/bin",
            ].join(NodePath.delimiter),
            PI_CODING_AGENT_DIR: cwd,
            T3_MCP_URL: `${origin}/mcp`,
            T3_MCP_BEARER_TOKEN: "fixture",
            T3_PI_MCP_EXTENSION_PATH: extension,
          },
        },
      );
      running.child.stdin?.end();
      await running;
      expect(modelRequests).toHaveLength(3);
      expect(JSON.stringify(modelRequests[0])).toContain("schedule_task — Schedule a fixture job.");
      expect(JSON.stringify(modelRequests[0])).not.toContain("fixtureJobDetails");
      expect(JSON.stringify(modelRequests[1])).toContain("fixtureJobDetails");
      expect(JSON.stringify(modelRequests[2])).toContain("fixture scheduled");
      expect(calls).toEqual([{ name: "schedule_task", arguments: { fixtureJobDetails: "job" } }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
  15_000,
);
