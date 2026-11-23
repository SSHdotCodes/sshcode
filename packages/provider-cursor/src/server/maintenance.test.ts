import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { latestCursorVersion, resolveCursorMaintenance } from "./maintenance.ts";

const latest = "2026.12.02-new123";
const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        `DOWNLOAD_URL="https://downloads.cursor.com/lab/${latest}/linux/arm64/agent-cli-package.tar.gz"`,
      ),
    ),
  ),
);

it.effect("reads the official release without executing the installer", () =>
  latestCursorVersion().pipe(
    Effect.tap((version) => Effect.sync(() => expect(version).toBe(latest))),
    Effect.provideService(HttpClient.HttpClient, http),
  ),
);

it.effect(
  "updates the exact native CLI and preserves the instance home without launching it during checks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-maintenance-" });
      const home = yield* fs.realPath(root);
      const bin = `${home}/.local/share/cursor-agent/versions/2026.08.04-old123/cursor-agent`;
      yield* fs.makeDirectory(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(bin, "#!/bin/sh\nexit 99\n");
      yield* fs.chmod(bin, 0o755);
      const env = { HOME: home, PATH: "", CURSOR_API_KEY: "instance-key" };
      const capabilities = yield* resolveCursorMaintenance(bin, env);
      expect(capabilities.installedVersion).toBe("2026.08.04-old123");
      expect(capabilities.latestVersion).toBe(latest);
      expect(capabilities.update).toMatchObject({ executable: bin, args: ["update"], env });
      const otherHome = yield* resolveCursorMaintenance(bin, { ...env, HOME: `${home}/other` });
      expect(otherHome.update).toBeNull();
      expect(otherHome.manualUpdateCommand).toContain("update");
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HttpClient.HttpClient, http),
    ),
);

it.effect("does not offer an update when the CLI is absent, even if the SDK is available", () =>
  resolveCursorMaintenance("/missing/cursor-agent", { PATH: "" }).pipe(
    Effect.tap((capabilities) =>
      Effect.sync(() => {
        expect(capabilities.update).toBeNull();
        expect(capabilities.installedVersion).toBeNull();
        expect(capabilities.latestVersion).toBeNull();
      }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.provideService(HttpClient.HttpClient, http),
  ),
);

it.effect("ignores malformed or failed official release responses", () =>
  latestCursorVersion().pipe(
    Effect.tap((version) => Effect.sync(() => expect(version).toBeNull())),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
        ),
      ),
    ),
  ),
);

it.effect("uses the owning Homebrew channel instead of the newer native release channel", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-brew-update-" });
    const prefix = yield* fs.realPath(root);
    const bin = `${prefix}/Cellar/cursor-cli/2026.08.04-old123/bin/agent`;
    yield* fs.makeDirectory(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
    yield* fs.makeDirectory(`${prefix}/bin`, { recursive: true });
    yield* fs.writeFileString(bin, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(bin, 0o755);
    const quotedPrefix = `'${prefix.replaceAll("'", "'\\''")}'`;
    yield* fs.writeFileString(
      `${prefix}/bin/brew`,
      `#!/bin/sh
if [ "$1" = "--prefix" ]; then printf '%s\\n' ${quotedPrefix}; else printf '%s\\n' '{"formulae":[{"versions":{"stable":"2026.09.01-brew123"}}]}'; fi
`,
    );
    yield* fs.chmod(`${prefix}/bin/brew`, 0o755);
    const capabilities = yield* resolveCursorMaintenance(bin, { HOME: `${prefix}/home`, PATH: "" });
    expect(capabilities.latestVersion).toBe("2026.09.01-brew123");
    expect(capabilities.update?.command).toBe("brew upgrade cursor-cli");
    expect(capabilities.update?.executable).toBe(`${prefix}/bin/brew`);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HttpClient.HttpClient, http),
  ),
);
