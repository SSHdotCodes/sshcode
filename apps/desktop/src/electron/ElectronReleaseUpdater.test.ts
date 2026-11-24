// @effect-diagnostics nodeBuiltinImport:off - creates temp resources dir with app-update.yml for ElectronReleaseUpdater.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vite-plus/test";

const electronAppMock = vi.hoisted(() => ({
  appPath: "/Applications/SSHCode.app/Contents/Resources/app.asar",
  exePath: "/Applications/SSHCode.app/Contents/MacOS/SSHCode",
  userDataPath: "/tmp/sshcode-user-data",
  version: "0.1.0",
  runningUnderARM64Translation: false,
  quit: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => electronAppMock.appPath,
    getPath: (name: string) =>
      name === "exe" ? electronAppMock.exePath : electronAppMock.userDataPath,
    getVersion: () => electronAppMock.version,
    get runningUnderARM64Translation() {
      return electronAppMock.runningUnderARM64Translation;
    },
    quit: electronAppMock.quit,
  },
}));

import * as ElectronReleaseUpdater from "./ElectronReleaseUpdater.ts";
import { ElectronUpdater } from "./ElectronUpdater.ts";

describe("ElectronReleaseUpdater", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  });

  it.effect(
    "selects arm64 updates when running an Intel build under Rosetta on Apple Silicon",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "electron-release-updater-")),
        );
        roots.push(root);
        const resources = NodePath.join(root, "Contents", "Resources");
        yield* Effect.promise(() => NodeFSP.mkdir(resources, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(resources, "app-update.yml"),
            "owner: SSHdotCodes\nrepo: sshcode\nprovider: github\n",
          ),
        );
        electronAppMock.appPath = NodePath.join(resources, "app.asar");
        electronAppMock.exePath = NodePath.join(root, "Contents", "MacOS", "SSHCode");
        electronAppMock.userDataPath = NodePath.join(root, "userData");
        electronAppMock.version = "0.1.0";
        electronAppMock.runningUnderARM64Translation = true;

        vi.spyOn(globalThis, "fetch").mockResolvedValue(
          Response.json({
            tag_name: "v0.1.1",
            draft: false,
            prerelease: false,
            body: "Apple Silicon release.",
            published_at: "2026-11-23T20:00:00Z",
            assets: [
              {
                name: "SSHCode-0.1.1-arm64.dmg",
                size: 100,
                browser_download_url:
                  "https://github.com/SSHdotCodes/sshcode/releases/download/v0.1.1/SSHCode-0.1.1-arm64.dmg",
              },
              {
                name: "SSHCode-0.1.1-arm64.dmg.sha256",
                size: 80,
                browser_download_url:
                  "https://github.com/SSHdotCodes/sshcode/releases/download/v0.1.1/SSHCode-0.1.1-arm64.dmg.sha256",
              },
            ],
          }),
        );

        const events: Array<[string, unknown]> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updater = yield* ElectronUpdater;
            yield* updater.on("update-available", (info) => {
              events.push(["update-available", info]);
            });
            yield* updater.on("update-not-available", (info) => {
              events.push(["update-not-available", info]);
            });
            yield* updater.checkForUpdates;
          }),
        ).pipe(
          Effect.provide(
            ElectronReleaseUpdater.layer.pipe(
              Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
            ),
          ),
        );

        assert.deepStrictEqual(events, [
          [
            "update-available",
            {
              version: "0.1.1",
              releaseNotes: "Apple Silicon release.",
              releaseDate: "2026-11-23T20:00:00Z",
            },
          ],
        ]);
      }),
  );
});
