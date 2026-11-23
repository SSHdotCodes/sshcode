import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercises the real CLI subprocess and its stdio/exit behavior.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real loopback fixture tests the Promise CLI adapter without a SSHCode server.
import * as NodeHttp from "node:http";
import { createSecretRedactor, runSecretCommand } from "./secret.ts";

const fake = "obviously-fake-κ-api-key";
describe("API key child output redaction", () => {
  it("redacts every byte boundary, Unicode, repeated and overlapping values on flush", () => {
    const bytes = Buffer.from(`prefix ${fake}${fake} suffix`);
    for (let split = 0; split <= bytes.length; split++) {
      const output: Buffer[] = [];
      const redact = createSecretRedactor([fake], (value) => output.push(value));
      redact.push(bytes.subarray(0, split));
      redact.push(bytes.subarray(split));
      redact.end();
      expect(Buffer.concat(output).toString()).toBe("prefix [REDACTED][REDACTED] suffix");
    }
    const output: Buffer[] = [];
    const redact = createSecretRedactor(["test", "test-long"], (value) => output.push(value));
    for (const byte of Buffer.from("test-long test test-lo")) redact.push(Buffer.from([byte]));
    redact.end();
    expect(Buffer.concat(output).toString()).toBe("[REDACTED] [REDACTED] [REDACTED]-lo");
  });
});

async function withEndpoint(
  body: (endpoint: string, seen: Array<string | undefined>) => Promise<void>,
  status = 200,
) {
  const seen: Array<string | undefined> = [];
  const server = NodeHttp.createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "FAKE_API_KEY", value: fake }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no test listener");
  try {
    await body(`http://127.0.0.1:${address.port}/mcp/api-key`, seen);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it("injects privately into the child, redacts stdout/stderr and preserves exit status", () =>
  withEndpoint(async (endpoint, seen) => {
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const code = await runSecretCommand({
      endpoint,
      ticket: "fake-ticket",
      name: "FAKE_API_KEY",
      command: [
        process.execPath,
        "-e",
        "const k = process.env.FAKE_API_KEY; process.stdout.write('out:' + k); process.stderr.write('err:' + k); process.exitCode = 7;",
      ],
      stdout: (bytes) => stdout.push(bytes),
      stderr: (bytes) => stderr.push(bytes),
    });
    expect(code).toBe(7);
    expect(seen).toEqual(["Bearer fake-ticket"]);
    expect(Buffer.concat(stdout).toString()).toBe("out:[REDACTED]");
    expect(Buffer.concat(stderr).toString()).toBe("err:[REDACTED]");
    expect(process.env.FAKE_API_KEY).toBeUndefined();
  }));

it("does not spawn on denied tickets or expose server response bodies", () =>
  withEndpoint(async (endpoint) => {
    await expect(
      runSecretCommand({
        endpoint,
        ticket: "fake-expired",
        name: "FAKE_API_KEY",
        command: [process.execPath, "-e", "throw new Error('must not run')"],
      }),
    ).rejects.toThrow("Call prepare_api_key again");
  }, 403));

it("refuses remote endpoints, credentials in URLs, and mismatched names", async () => {
  await expect(
    runSecretCommand({
      endpoint: "http://example.invalid/mcp/api-key",
      ticket: "fake",
      name: "FAKE_API_KEY",
      command: ["echo"],
    }),
  ).rejects.toThrow("Could not run");
  await withEndpoint(async (endpoint, seen) => {
    await expect(
      runSecretCommand({ endpoint, ticket: "fake", name: "OTHER_KEY", command: ["echo"] }),
    ).rejects.toThrow("Could not run");
    await expect(
      runSecretCommand({
        endpoint: endpoint.replace("127.0.0.1", "user@127.0.0.1"),
        ticket: "fake",
        name: "FAKE_API_KEY",
        command: ["echo"],
      }),
    ).rejects.toThrow("Could not run");
    expect(seen).toHaveLength(1);
  });
});

it("the sshcode CLI parses command arguments after -- and preserves child exit status", () =>
  withEndpoint(async (endpoint) => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "src/bin.ts",
            "secret",
            "run",
            "--endpoint",
            endpoint,
            "--ticket",
            "fake-ticket",
            "--env",
            "FAKE_API_KEY",
            "--",
            process.execPath,
            "-e",
            "process.stdout.write(process.env.FAKE_API_KEY); process.exitCode = 6;",
          ],
          { cwd: import.meta.dirname + "/../..", stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes: Buffer) => {
          stdout += bytes.toString();
        });
        child.stderr.on("data", (bytes: Buffer) => {
          stderr += bytes.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
    expect(result.code).toBe(6);
    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stderr).not.toContain(fake);
  }));
