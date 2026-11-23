// @effect-diagnostics nodeBuiltinImport:off -- dev-only CLI and mock HTTP boundary.
import * as NodeHttp from "node:http";
import { expect, it } from "vite-plus/test";
import { codexArgs, fixturePaths, listenMock } from "./codex-cli.ts";

it("isolates the CLI's config, filesystem, MCP servers and session storage", () => {
  const args = codexArgs({
    model: "test-model",
    effort: "xhigh",
    fixture: "/fixture",
    url: "http://127.0.0.1:45000/mcp",
    instructions: "owned text",
    tools: ["ask_user"],
  });
  expect(args).toContain("--ephemeral");
  expect(args).toContain("--ignore-user-config");
  expect(args).toContain("--ignore-rules");
  expect(args).toContain(
    'permissions.eval.filesystem={":minimal"="read",":workspace_roots"="read"}',
  );
  expect(args).toContain("permissions.eval.network.enabled=false");
  expect(args).toContain('mcp_servers={t3-code={url="http://127.0.0.1:45000/mcp",required=true}}');
  expect(args).toContain('mcp_servers.t3-code.tools.ask_user.approval_mode="approve"');
  expect(args).toContain('model_reasoning_effort="xhigh"');
  expect(args).toContain('developer_instructions="owned text"');
});

it("advertises exactly the supplied branch tools and answers only the mock", async () => {
  const tools = [
    {
      name: "example",
      description: "Branch description",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: { action: { enum: ["read"] } },
      },
    },
  ];
  const calls: Array<unknown> = [];
  const mock = await listenMock(tools, async (name, input) => {
    calls.push({ name, input });
    return { value: 3 };
  });
  const request = (method: string, params = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const req = NodeHttp.request(
        mock.url,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8").on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve(JSON.parse(body));
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
  try {
    expect(await request("tools/list")).toMatchObject({ result: { tools } });
    expect(
      await request("tools/call", { name: "example", arguments: { action: "read" } }),
    ).toMatchObject({ result: { content: [{ type: "text", text: '{"value":3}' }] } });
    expect(calls).toEqual([{ name: "example", input: { action: "read" } }]);
    expect(await request("tools/call", { name: "not-a-branch-tool" })).toEqual({
      error: "Invalid eval request",
    });
    expect(calls).toHaveLength(1);
    expect(new URL(mock.url).hostname).toBe("127.0.0.1");
    const port = Number(new URL(mock.url).port);
    expect((port >= 18000 && port <= 18999) || (port >= 38000 && port <= 38999)).toBe(false);
  } finally {
    await mock.close();
  }
});

it("keeps synthetic absolute paths inside the fixture and restores grading paths", () => {
  const paths = fixturePaths("/fixture/root");
  const original = {
    "/tmp/design/index.html": "read /tmp/design/index.html from /home/user/app",
    nested: ["/Users/dev/repo"],
  };
  const translated = paths.intoFixture(original);
  expect(translated).toEqual({
    "/fixture/root/world/tmp/design/index.html":
      "read /fixture/root/world/tmp/design/index.html from /fixture/root",
    nested: ["/fixture/root/world/Users/dev/repo"],
  });
  expect(paths.fromFixture(translated)).toEqual(original);
});
