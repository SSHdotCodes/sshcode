// @effect-diagnostics nodeBuiltinImport:off -- CLI process/stream boundary. Child output must pass through the redactor.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/cli";

/** Byte matching handles UTF-8, overlapping keys, and secrets split across arbitrary pipe chunks. */
export function createSecretRedactor(
  values: ReadonlyArray<string>,
  write: (bytes: Buffer) => void,
) {
  const secrets = values
    .filter(Boolean)
    .map((value) => Buffer.from(value))
    .sort((a, b) => b.length - a.length);
  const longest = Math.max(1, ...secrets.map((value) => value.length));
  let pending = Buffer.alloc(0);
  const drain = (final: boolean) => {
    const output: Buffer[] = [];
    let offset = 0;
    const limit = final ? pending.length : Math.max(0, pending.length - longest + 1);
    while (offset < limit) {
      let next = -1;
      let matched: Buffer | undefined;
      for (const secret of secrets) {
        const found = pending.indexOf(secret, offset);
        if (found >= 0 && (next < 0 || found < next)) {
          next = found;
          matched = secret;
        }
      }
      if (next < 0 || next >= limit || matched === undefined) {
        output.push(pending.subarray(offset, limit));
        offset = limit;
        break;
      }
      output.push(pending.subarray(offset, next), Buffer.from("[REDACTED]"));
      offset = next + matched.length;
    }
    if (output.length > 0) write(Buffer.concat(output));
    pending = Buffer.from(pending.subarray(offset));
  };
  return {
    push: (bytes: Uint8Array) => {
      pending = Buffer.concat([pending, bytes]);
      drain(false);
    },
    end: () => drain(true),
  };
}

const decodeKeyResponse = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String, value: Schema.String }),
);

class SecretRunError extends Error {
  override readonly name = "SecretRunError";
  constructor() {
    super(
      "Could not run with this API key. Call prepare_api_key again and use its command on the server host.",
    );
  }
}

/** Fetch only over loopback with a one-use bearer ticket, then inject into a direct child. */
export async function runSecretCommand(input: {
  readonly endpoint: string;
  readonly ticket: string;
  readonly name: string;
  readonly command: ReadonlyArray<string>;
  readonly stdout?: (bytes: Buffer) => void;
  readonly stderr?: (bytes: Buffer) => void;
}): Promise<number> {
  try {
    const endpoint = new URL(input.endpoint);
    if (
      endpoint.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.pathname !== "/mcp/api-key" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(input.name) ||
      !input.command[0]
    )
      throw new SecretRunError();
    // @effect-diagnostics-next-line globalFetch:off -- Promise CLI adapter; disables redirects before any bearer credential is sent.
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${input.ticket}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SecretRunError();
    const payload = decodeKeyResponse(await response.json());
    if (
      !("name" in payload) ||
      payload.name !== input.name ||
      !("value" in payload) ||
      typeof payload.value !== "string" ||
      !payload.value ||
      payload.value.includes("\0") ||
      payload.value.length > 16_384
    )
      throw new SecretRunError();
    const value = payload.value;
    return await new Promise<number>((resolve, reject) => {
      const child = NodeChildProcess.spawn(input.command[0]!, input.command.slice(1), {
        shell: false,
        env: { ...process.env, [input.name]: value },
        stdio: ["inherit", "pipe", "pipe"],
      });
      const stdout = createSecretRedactor(
        [value],
        input.stdout ??
          ((bytes) => {
            process.stdout.write(bytes);
          }),
      );
      const stderr = createSecretRedactor(
        [value],
        input.stderr ??
          ((bytes) => {
            process.stderr.write(bytes);
          }),
      );
      child.stdout.on("data", stdout.push);
      child.stderr.on("data", stderr.push);
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      child.on("error", () => {
        cleanup();
        reject(new SecretRunError());
      });
      child.on("close", (code, signal) => {
        cleanup();
        stdout.end();
        stderr.end();
        resolve(code ?? (signal === "SIGINT" ? 130 : 143));
      });
    });
  } catch {
    throw new SecretRunError();
  }
}

const run = Command.make("run", {
  endpoint: Flag.String("endpoint"),
  ticket: Flag.String("ticket"),
  name: Flag.String("env"),
  command: Argument.String("command").pipe(Argument.variadic({ min: 1 })),
}).pipe(
  Command.withDescription(
    "Run a command with a private API key. First call the prepare_api_key MCP tool for a one-use ticket. Exact echoed values are redacted; do not write or transform credentials.",
  ),
  Command.withHandler((input) =>
    Effect.tryPromise({
      try: () => runSecretCommand(input),
      catch: () => new SecretRunError(),
    }).pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
      Effect.asVoid,
    ),
  ),
);
export const secretCommand = Command.make("secret").pipe(
  Command.withDescription("Use saved API keys without displaying their values."),
  Command.withSubcommands([run]),
);
