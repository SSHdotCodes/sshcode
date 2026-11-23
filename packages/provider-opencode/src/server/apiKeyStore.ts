import { resolveCommandPath } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Hex from "effect/encoding/Hex";

import { OpenCodeRuntimeError } from "./OpenCodeRuntime.ts";
import type { ProbedOpenCode } from "./versionProbe.ts";

const SHARED_CHANNELS = new Set(["latest", "dev", "beta", "next", "prod"]);

/** Resolve store identity without opening the credential file or listing credentials. */
export const openCodeApiKeyStoreId = Effect.fn("openCodeApiKeyStoreId")(function* (input: {
  readonly instanceId: string;
  readonly runtime: ProbedOpenCode;
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { generation, channel } = input.runtime;
  if (input.serverUrl.trim()) {
    const url = new URL(input.serverUrl.trim());
    url.username = "";
    url.password = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    // Query parameters may route to distinct servers. Hash the endpoint so a query
    // containing authentication data never appears in the ID.
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(url.href)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "apiKeyStoreId",
            detail: "Could not identify the OpenCode server credential store.",
            cause,
          }),
      ),
    );
    return `opencode:${generation}:server:${digest}`;
  }

  const { environment } = input;
  if (
    (generation === "v1" && environment.OPENCODE_AUTH_CONTENT) ||
    (generation === "v2" && environment.OPENCODE_DB === ":memory:")
  ) {
    return yield* new OpenCodeRuntimeError({
      operation: "apiKeyStoreId",
      detail: "OpenCode is using a credential override that cannot be replaced persistently.",
    });
  }
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const dataDirectory = path.resolve(
    input.directory,
    environment.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "opencode",
  );
  const database =
    environment.OPENCODE_DB ??
    (!channel ||
    SHARED_CHANNELS.has(channel) ||
    environment.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    environment.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
  const filename = path.resolve(dataDirectory, generation === "v1" ? "auth.json" : database);
  const canonical = yield* fs.realPath(filename).pipe(
    Effect.catch(() =>
      fs.realPath(path.dirname(filename)).pipe(
        Effect.map((directory) => path.join(directory, path.basename(filename))),
        Effect.orElseSucceed(() => filename),
      ),
    ),
  );
  const executable = yield* resolveCommandPath(input.binaryPath, { env: environment });
  // A wrapper may change HOME, XDG_DATA_HOME or OPENCODE_DB before launching OpenCode.
  // Only native executables can be grouped by the inherited environment alone.
  const native = executable
    ? yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(executable);
          const bytes = yield* file.readAlloc(4);
          if (bytes._tag === "None") return false;
          const magic = Array.from(bytes.value, (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
          );
          return (
            magic === "7f454c46" ||
            magic.startsWith("4d5a") ||
            ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(magic)
          );
        }),
      ).pipe(Effect.orElseSucceed(() => false))
    : false;
  return [
    "opencode",
    generation,
    canonical,
    ...(native ? [] : ["wrapper", executable ?? input.binaryPath, input.instanceId]),
  ]
    .map(encodeURIComponent)
    .join(":");
});
