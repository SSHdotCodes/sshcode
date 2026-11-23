// @effect-diagnostics nodeBuiltinImport:off - builds fake app bundles on disk for the updater, which uses Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  compareReleaseVersions,
  createReleaseDmgUpdater,
  installTarget,
  parseReleaseFeed,
  releaseCandidate,
  type ReleaseDmgUpdaterDeps,
} from "./ReleaseDmgUpdater.ts";

describe("compareReleaseVersions", () => {
  it("orders versions numerically, releases after their prereleases", () => {
    expect(compareReleaseVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareReleaseVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareReleaseVersions("0.0.46-nightly.20261015.3559", "0.1.0")).toBe(-1);
    expect(compareReleaseVersions("latest", "0.1.0")).toBeNull();
  });
});

describe("parseReleaseFeed", () => {
  it("reads a GitHub feed and ignores anything else", () => {
    expect(
      parseReleaseFeed(
        "owner: SSHdotCodes\nrepo: sshcode\nprovider: github\nreleaseType: release\n",
      ),
    ).toEqual({ owner: "SSHdotCodes", repo: "sshcode" });
    expect(parseReleaseFeed("provider: generic\nurl: http://localhost:3000\n")).toBeNull();
    expect(parseReleaseFeed("provider: github\nowner: a/b\nrepo: c\n")).toBeNull();
  });
});

const release = (version: string, assets: ReadonlyArray<string>, extra: object = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  body: "Fixes things.",
  published_at: "2026-11-23T20:00:00Z",
  assets: assets.map((name) => ({
    name,
    size: 100,
    browser_download_url: `https://github.com/SSHdotCodes/sshcode/releases/download/v${version}/${name}`,
  })),
  ...extra,
});

describe("releaseCandidate", () => {
  it("picks the disk image for this Mac's architecture with its checksum", () => {
    const candidate = releaseCandidate(
      release("0.1.1", ["SSHCode-0.1.1-arm64.dmg", "SSHCode-0.1.1-arm64.dmg.sha256"]),
      "arm64",
    );
    expect(candidate).toMatchObject({ version: "0.1.1", notes: "Fixes things.", dmgSize: 100 });
    expect(candidate?.dmgUrl.endsWith("SSHCode-0.1.1-arm64.dmg")).toBe(true);
  });

  it("skips releases without a checksum, for another chip, or still drafts", () => {
    expect(releaseCandidate(release("0.1.1", ["SSHCode-0.1.1-arm64.dmg"]), "arm64")).toBeNull();
    expect(
      releaseCandidate(
        release("0.1.1", ["SSHCode-0.1.1-arm64.dmg", "SSHCode-0.1.1-arm64.dmg.sha256"]),
        "x64",
      ),
    ).toBeNull();
    expect(
      releaseCandidate(
        release("0.1.1", ["SSHCode-0.1.1-arm64.dmg", "SSHCode-0.1.1-arm64.dmg.sha256"], {
          draft: true,
        }),
        "arm64",
      ),
    ).toBeNull();
  });
});

describe("installTarget", () => {
  it("names the running bundle and refuses places it can't replace itself", () => {
    expect(installTarget("/Applications/SSHCode.app/Contents/MacOS/SSHCode")).toEqual({
      app: "/Applications/SSHCode.app",
    });
    expect(
      installTarget(
        "/private/var/folders/x/AppTranslocation/ABC/d/SSHCode.app/Contents/MacOS/SSHCode",
      ),
    ).toHaveProperty("blocked");
    expect(installTarget("/Volumes/SSHCode/SSHCode.app/Contents/MacOS/SSHCode")).toHaveProperty(
      "blocked",
    );
  });
});

describe("createReleaseDmgUpdater", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  });

  const setup = async (
    options: { readonly checksum?: string; readonly latest?: string; readonly feed?: boolean } = {},
  ) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-updater-"));
    roots.push(root);
    const app = NodePath.join(root, "Applications", "SSHCode.app");
    await NodeFSP.mkdir(NodePath.join(app, "Contents", "MacOS"), { recursive: true });
    const appUpdateYml = NodePath.join(root, "app-update.yml");
    if (options.feed !== false) {
      await NodeFSP.writeFile(
        appUpdateYml,
        "owner: SSHdotCodes\nrepo: sshcode\nprovider: github\n",
      );
    }
    const latest = options.latest ?? "0.1.1";
    const dmgBytes = new TextEncoder().encode("disk image bytes");
    const checksum =
      options.checksum ?? NodeCrypto.createHash("sha256").update(dmgBytes).digest("hex");
    const calls: Array<string> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    let quit = 0;
    const plist: Record<string, string> = {};
    const deps: ReleaseDmgUpdaterDeps = {
      fetch: (async (url: string) => {
        calls.push(`fetch ${url}`);
        if (url.endsWith("/releases/latest")) {
          return Response.json(
            release(latest, [`SSHCode-${latest}-arm64.dmg`, `SSHCode-${latest}-arm64.dmg.sha256`]),
          );
        }
        if (url.endsWith(".sha256")) return new Response(`${checksum}  SSHCode-0.1.1-arm64.dmg\n`);
        return new Response(dmgBytes, { headers: { "content-length": String(dmgBytes.length) } });
      }) as unknown as typeof globalThis.fetch,
      run: async (command, args) => {
        calls.push(`${command} ${args[0]}`);
        if (command === "hdiutil" && args[0] === "attach") {
          const mount = args[args.length - 1]!;
          await NodeFSP.mkdir(NodePath.join(mount, "SSHCode.app", "Contents"), { recursive: true });
        }
        if (command === "ditto") await NodeFSP.cp(args[0]!, args[1]!, { recursive: true });
        if (command === "plutil") {
          const [, key, , plistPath] = args;
          const staged = !plistPath!.startsWith(app);
          if (key === "CFBundleShortVersionString") return staged ? "0.1.1\n" : "0.1.0\n";
          return plist.identifier ?? "com.example.sshcode\n";
        }
        return "";
      },
      spawnDetached: (_command, args) => spawned.push(args),
      quit: () => {
        quit += 1;
      },
      currentVersion: () => "0.1.0",
      arch: "arm64",
      execPath: NodePath.join(app, "Contents", "MacOS", "SSHCode"),
      pid: 4242,
      appUpdateYmlPath: appUpdateYml,
      updatesDir: () => NodePath.join(root, "updates"),
    };
    const updater = createReleaseDmgUpdater(deps);
    const events: Array<[string, unknown]> = [];
    for (const name of [
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
    ]) {
      updater.on(name, (info: unknown) => events.push([name, info]));
    }
    return { updater, events, calls, spawned, app, root, quitCount: () => quit };
  };

  it("checks, downloads, verifies and installs a newer release", async () => {
    const { updater, events, calls, spawned, app, root, quitCount } = await setup();
    await updater.checkForUpdates();
    expect(events[0]).toEqual([
      "update-available",
      { version: "0.1.1", releaseNotes: "Fixes things.", releaseDate: "2026-11-23T20:00:00Z" },
    ]);

    await updater.downloadUpdate();
    expect(events.some(([name]) => name === "download-progress")).toBe(true);
    expect(events.at(-1)?.[0]).toBe("update-downloaded");
    expect(calls).toContain("codesign --verify");
    expect(calls.filter((call) => call.startsWith("hdiutil detach"))).toHaveLength(1);
    const staged = NodePath.join(root, "updates", "0.1.1", "SSHCode.app");
    await expect(NodeFSP.stat(staged)).resolves.toBeTruthy();

    updater.quitAndInstall();
    expect(spawned).toEqual([
      [
        NodePath.join(root, "updates", "install.sh"),
        "4242",
        app,
        staged,
        NodePath.join(root, "updates", "previous.app"),
      ],
    ]);
    expect(quitCount()).toBe(1);
  });

  it("refuses an image that doesn't match its published checksum", async () => {
    const { updater, events } = await setup({ checksum: "0".repeat(64) });
    await updater.checkForUpdates();
    await expect(updater.downloadUpdate()).rejects.toThrow("didn't match its published checksum");
    expect(events.some(([name]) => name === "update-downloaded")).toBe(false);
  });

  it("reports no update when the latest release isn't newer", async () => {
    const { updater, events } = await setup({ latest: "0.1.0" });
    await updater.checkForUpdates();
    expect(events).toEqual([["update-not-available", { version: "0.1.0" }]]);
    await expect(updater.downloadUpdate()).rejects.toThrow("Check for updates");
  });

  it("says so when the build has no release feed", async () => {
    const { updater } = await setup({ feed: false });
    await expect(updater.checkForUpdates()).rejects.toThrow("no release feed");
  });
});
