import { describe, expect, it } from "vite-plus/test";
import { MCP_APPS, OTHER_MCP_APPS, mcpDestinationMismatch, mcpHandoffAction } from "./mcpApps";
const MCP_URL = "https://example.test/mcp?x=1&y=two words";

describe("MCP app handoffs", () => {
  it("prefills SSHCode and the complete encoded URL for hosted Claude and Poke", () => {
    const opened = (id: string) =>
      new URL(
        mcpHandoffAction(
          MCP_APPS.find((app) => app.id === id)!,
          MCP_URL,
        )!.link,
      );
    expect(opened("poke").searchParams.get("name")).toBe("SSHCode");
    expect(opened("poke").searchParams.get("url")).toBe(MCP_URL);
    expect(opened("claude").searchParams.get("connectorName")).toBe("SSHCode");
    expect(opened("claude").searchParams.get("connectorUrl")).toBe(MCP_URL);
  });
  it.each([...MCP_APPS, ...OTHER_MCP_APPS])(
    "$name copies just its URL or a complete one-line command",
    (app) => {
      const action = mcpHandoffAction(app, MCP_URL);
      if (action) expect(new URL(action.link).protocol).toBe("https:");
      if (app.handoff.kind === "copy-url") expect(action?.copy?.text).toBe(MCP_URL);
      if (app.handoff.kind === "commands") {
        expect(action).toBeNull();
        expect(app.handoff.command(MCP_URL)).toContain(`'${MCP_URL}'`);
        expect(app.handoff.command(MCP_URL)).not.toContain("\n");
      }
    },
  );
  it.each(["claude-code", "codex"])("%s needs one pasted command to add and sign in", (id) => {
    const app = OTHER_MCP_APPS.find((app) => app.id === id)!;
    if (app.handoff.kind !== "commands") throw new Error("Expected a CLI command");
    const command = app.handoff.command("http://127.0.0.1:3773/mcp");
    const cli = id === "claude-code" ? "claude" : "codex";
    expect(command).toContain(`${cli} mcp add`);
    if (id === "claude-code") expect(command).toContain(" && claude mcp login sshcode");
    else expect(command).not.toContain("mcp login");
    expect(app.publicAddress).toBe(false);
  });
  it("quotes a URL before placing it in any shell command", () => {
    for (const app of [...MCP_APPS, ...OTHER_MCP_APPS])
      if (app.handoff.kind === "commands") {
        expect(app.handoff.command("https://example.test/mcp?value='$(echo bad)'")).toContain(
          "'https://example.test/mcp?value='\\''$(echo bad)'\\'''",
        );
      }
  });
});

describe("MCP sign-in destinations", () => {
  const app = (id: string) => [...MCP_APPS, ...OTHER_MCP_APPS].find((app) => app.id === id)!;

  it.each(["claude-code", "codex"])("warns when %s would send access outside loopback", (id) => {
    for (const destination of [
      "unexpected.example",
      "claude.ai",
      "localhost.evil.example:8080",
      "127.0.0.1.evil.example",
      "192.168.1.2:3773",
    ])
      expect(mcpDestinationMismatch(app(id), destination), destination).toBe(true);
  });

  it.each(["claude-code", "codex"])("accepts %s loopback callbacks with any port", (id) => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"])
      for (const port of ["", ":80", ":443", ":3773", ":65535"])
        expect(mcpDestinationMismatch(app(id), hostname + port), hostname + port).toBe(false);
  });

  it.each([
    ["claude", "claude.ai"],
    ["chatgpt", "chatgpt.com"],
  ])("matches the whole %s callback hostname", (id, hostname) => {
    expect(mcpDestinationMismatch(app(id), hostname)).toBe(false);
    expect(mcpDestinationMismatch(app(id), `${hostname.toUpperCase()}:443`)).toBe(false);
    for (const destination of [`${hostname}.evil.example`, `evil${hostname}`, `sub.${hostname}`])
      expect(mcpDestinationMismatch(app(id), destination), destination).toBe(true);
  });

  it("leaves arbitrary MCP apps and unconfirmed destinations without a warning", () => {
    for (const id of ["other", "poke", "grok-bot", "muse", "instinct", "openclaw", "hermes-agent"])
      expect(mcpDestinationMismatch(app(id), "unexpected.example:8443"), id).toBe(false);
  });
});
