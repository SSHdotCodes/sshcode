// @effect-diagnostics nodeBuiltinImport:off -- dev-only CLI and mock HTTP boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { useTempDirs } from "@t3tools/shared/testing/tempDirs";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import {
  codexArgs,
  codexSandboxArgs,
  fixturePaths,
  listenMock,
  withCliFixture,
} from "./codex-cli.ts";

const tempDir = useTempDirs();
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

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
  expect(args).toContain(codexSandboxArgs[3]);
  expect(args).toContain("permissions.eval.network.enabled=false");
  expect(args).toContain('approval_policy="never"');
  expect(args).toContain('forced_login_method="chatgpt"');
  expect(args).toContain("agents.enabled=false");
  expect(args).toContain("features.multi_agent_v2=false");
  const withNative = codexArgs({
    model: "test-model",
    effort: "xhigh",
    fixture: "/fixture",
    url: "http://127.0.0.1:45000/mcp",
    instructions: "owned text",
    nativeAgents: true,
  });
  expect(withNative).not.toContain("agents.enabled=false");
  expect(withNative).not.toContain("features.multi_agent_v2=false");
  expect(args).toContain('mcp_servers={t3-code={url="http://127.0.0.1:45000/mcp",required=true}}');
  expect(args).toContain('mcp_servers.t3-code.tools.ask_user.approval_mode="approve"');
  expect(args).toContain('model_reasoning_effort="xhigh"');
  expect(args).toContain('developer_instructions="owned text"');
});

it("seeds independent writable Git fixtures and removes them even if a sample fails", async () => {
  const root = tempDir("mcp-cli-fixture-");
  const world = { files: { "start.txt": "seed", "check.sh": "#!/bin/sh\nexit 0\n" } };
  const first = await withCliFixture(root, world, async ({ fixture, runtimeDirectory }) => {
    expect(await NodeFSP.readFile(NodePath.join(fixture, "start.txt"), "utf8")).toBe("seed");
    expect((await NodeFSP.stat(NodePath.join(fixture, "check.sh"))).mode & 0o300).toBe(0o300);
    await NodeFSP.writeFile(NodePath.join(fixture, "start.txt"), "changed");
    expect((await execFile("git", ["diff", "--name-only"], { cwd: fixture })).stdout.trim()).toBe(
      "start.txt",
    );
    await NodeFSP.writeFile(NodePath.join(runtimeDirectory, "state"), "temporary");
    return fixture;
  });
  expect(await NodeFSP.readdir(root)).toEqual([]);
  await expect(
    withCliFixture(root, world, async ({ fixture }) => {
      expect(fixture).not.toBe(first);
      expect(await NodeFSP.readFile(NodePath.join(fixture, "start.txt"), "utf8")).toBe("seed");
      throw new Error("sample failed");
    }),
  ).rejects.toThrow("sample failed");
  await expect(
    withCliFixture(root, { files: { "../escape": "invalid" } }, async () => {}),
  ).rejects.toThrow("Fixture path escapes its root");
  expect(await NodeFSP.readdir(root)).toEqual([]);
});

it.effect("enforces the writable fixture with the installed Codex sandbox", (context) =>
  Effect.gen(function* () {
    if (
      (yield* HostProcess.Platform) !== "darwin" ||
      NodeChildProcess.spawnSync("codex", ["--version"], { stdio: "ignore" }).status !== 0
    ) {
      return context.skip();
    }
    yield* Effect.promise(async () => {
      const root = tempDir("mcp-cli-sandbox-");
      const mock = await listenMock([], async () => null);
      try {
        await withCliFixture(root, { files: { "seed.txt": "seed" } }, async (sample) => {
          const { fixture, runtimeDirectory, tempDirectory } = sample;
          const outside = NodePath.join(runtimeDirectory, "outside.txt");
          await NodeFSP.writeFile(outside, "outside");
          await NodeFSP.symlink(outside, NodePath.join(fixture, "outside-link"));
          const result = await execFile(
            "codex",
            [
              "sandbox",
              ...codexSandboxArgs,
              "--",
              "/bin/sh",
              "-c",
              [
                "set -eu",
                '[ "$(/bin/cat seed.txt)" = seed ]',
                "printf changed > seed.txt",
                'printf new > "$TMPDIR/new.txt"',
                'if /bin/cat "$1" >/dev/null 2>&1; then exit 2; fi',
                'if (printf invalid > "$1") 2>/dev/null; then exit 3; fi',
                "if (printf invalid > outside-link) 2>/dev/null; then exit 4; fi",
                'if /usr/bin/curl --max-time 2 -sS "$2" >/dev/null 2>&1; then exit 5; fi',
                "printf sandbox-ok",
              ].join("\n"),
              "probe",
              outside,
              mock.url,
            ],
            {
              cwd: fixture,
              env: { PATH: process.env.PATH, CODEX_HOME: runtimeDirectory, TMPDIR: tempDirectory },
              timeout: 5_000,
            },
          );
          expect(result.stdout).toBe("sandbox-ok");
          expect(await NodeFSP.readFile(NodePath.join(fixture, "seed.txt"), "utf8")).toBe(
            "changed",
          );
          expect(await NodeFSP.readFile(NodePath.join(tempDirectory, "new.txt"), "utf8")).toBe(
            "new",
          );
          expect(await NodeFSP.readFile(outside, "utf8")).toBe("outside");
        });
      } finally {
        await mock.close();
      }
    });
  }),
);

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

it("creates a missing fixture root", async () => {
  const root = NodePath.join(tempDir("mcp-cli-missing-"), "not-yet", "made");
  const seen = await withCliFixture(root, { files: { "a.txt": "a" } }, async ({ fixture }) =>
    NodeFSP.readFile(NodePath.join(fixture, "a.txt"), "utf8"),
  );
  expect(seen).toBe("a");
});
