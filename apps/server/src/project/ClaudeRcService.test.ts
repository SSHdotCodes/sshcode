import { expect, it } from "@effect/vitest";
import { ClaudeRcClient, claudeRcInputPlatform } from "./ClaudeRcService.ts";

const live = {
  id: "cse_test",
  title: "CLI task",
  updated_at: "2026-10-27",
  environment_kind: "bridge",
  status: "active",
  connection_status: "connected",
  worker_status: "idle",
  config: { origin: "claude_code_cli" },
  tags: ["remote-control-auto"],
};

it("never sends a prompt to an SDK/cloud or disconnected session", async () => {
  const requests: string[] = [];
  const client = new ClaudeRcClient(async (url) => {
    requests.push(String(url));
    return Response.json({ data: [{ ...live, config: { origin: "claude_code_sdk" } }] });
  });
  await expect(
    client.command(
      "native-login",
      { action: "send", sessionId: "cse_test", text: "hello" },
      "desktop_app",
    ),
  ).rejects.toThrow("not an open Claude Code CLI session");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("statuses=active");
});

it("marks keyboard input as human using the native CLI input contract", async () => {
  const posts: unknown[] = [];
  const client = new ClaudeRcClient(async (_url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(String(options.body)));
      return Response.json({});
    }
    return Response.json({ data: [live] });
  });
  await client.command(
    "native-login",
    { action: "send", sessionId: "cse_test", text: "hello" },
    "desktop_app",
  );
  expect(posts[0]).toMatchObject({ session_id: "cse_test" });
  const sent = posts[0] as { events: { payload: Record<string, unknown> }[] };
  expect(sent.events[0]?.payload.session_id).toBeUndefined();
  expect(posts[0]).toMatchObject({
    events: [
      { payload: { type: "user", origin: { kind: "human" }, message: { content: "hello" } } },
    ],
  });
});

it("attaches as an RC client and approves only the original worker request", async () => {
  const posts: Record<string, unknown>[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let permissionReady!: () => void;
  const permission = new Promise<void>((resolve) => {
    permissionReady = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const client = new ClaudeRcClient(async (url, options) => {
    const target = String(url);
    expect(target).not.toContain("/bridge");
    if (options?.method === "POST") {
      posts.push(JSON.parse(String(options.body)));
      return Response.json({});
    }
    if (target.endsWith("/events/stream"))
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ data: [live] });
  });
  const abort = new AbortController();
  const events: string[] = [];
  const watching = client
    .watch("native-login", "cse_test", abort.signal, (event) => {
      events.push(event.type);
      if (event.type === "permission") permissionReady();
    })
    .catch((error) => error);
  controller.enqueue(
    new TextEncoder().encode(
      `event: client_event\ndata: ${JSON.stringify({ source: "worker", payload: { type: "control_request", request_id: "approval", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tool-pwd", input: { command: "pwd" } } } })}\n\n`,
    ),
  );
  await permission;
  await expect(
    client.command(
      "native-login",
      {
        action: "permission",
        sessionId: "cse_test",
        requestId: "invented",
        allow: true,
      },
      "ios",
    ),
  ).rejects.toThrow("no longer pending");
  await client.command(
    "native-login",
    {
      action: "permission",
      sessionId: "cse_test",
      requestId: "approval",
      allow: true,
    },
    "ios",
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    session_id: "cse_test",
    events: [
      {
        payload: {
          type: "control_response",
          response: {
            request_id: "approval",
            response: {
              behavior: "allow",
              updatedInput: { command: "pwd" },
              toolUseID: "tool-pwd",
            },
          },
        },
      },
    ],
  });
  expect(events).toContain("permissionResolved");
  abort.abort();
  controller.close();
  await watching;
});

it("uses the actual app surface for keyboard input and rejects generic web input", async () => {
  expect(claudeRcInputPlatform("desktop", "macOS")).toBe("desktop_app");
  expect(claudeRcInputPlatform("mobile", "iOS")).toBe("ios");
  expect(claudeRcInputPlatform("mobile", "Android")).toBe("android");
  expect(claudeRcInputPlatform("web", "macOS")).toBeNull();
  expect(claudeRcInputPlatform("mobile", undefined)).toBeNull();
  const platforms: string[] = [];
  const payloads: unknown[] = [];
  const client = new ClaudeRcClient(async (_url, options) => {
    if (options?.method === "POST") {
      platforms.push(new Headers(options.headers).get("anthropic-client-platform") ?? "");
      expect(new Headers(options.headers).get("User-Agent")).toBe("SSHCode/terminal-rc");
      payloads.push(JSON.parse(String(options.body)));
      return Response.json({});
    }
    return Response.json({ data: [live] });
  });
  for (const platform of ["desktop_app", "ios", "android"] as const)
    await client.command(
      "native-login",
      { action: "send", sessionId: "cse_test", text: "hi" },
      platform,
    );
  await expect(
    client.command("native-login", { action: "send", sessionId: "cse_test", text: "hi" }, null),
  ).rejects.toThrow("Mac or mobile");
  expect(platforms).toEqual(["desktop_app", "ios", "android"]);
  expect(JSON.stringify(payloads)).not.toContain("inbound_origin");
  expect(JSON.stringify(payloads)).not.toContain("initialize");
});
