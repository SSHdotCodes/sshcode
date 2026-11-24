// @effect-diagnostics nodeBuiltinImport:off - stands in for electron-updater: a promise and event-emitter API driven from Electron's main process, not an Effect service.
/**
 * SSHCode's Mac updater for published releases. Release builds are ad hoc signed, and Squirrel.Mac
 * (electron-updater's Mac installer) refuses ad hoc signatures, so this stands in for it behind the
 * same ElectronUpdater service and events: it reads the GitHub repository app-update.yml names,
 * downloads the release's disk image, checks the SHA-256 published beside it, copies the app out,
 * and swaps the bundle once the app has quit. A build without app-update.yml never gets here.
 *
 * @module ReleaseDmgUpdater
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** One GitHub release, reduced to what an update needs. */
export interface ReleaseCandidate {
  readonly version: string;
  readonly notes: string | null;
  readonly publishedAt: string | null;
  readonly dmgUrl: string;
  readonly dmgSize: number | null;
  readonly sha256Url: string;
}

/** `1.2.3` against `1.2.10`, prereleases before their release; null when either isn't a version. */
export function compareReleaseVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) return null;
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const aParts = a.pre.split(".");
  const bParts = b.pre.split(".");
  const length = Math.min(aParts.length, bParts.length);
  for (let index = 0; index < length; index++) {
    const leftPart = aParts[index]!;
    const rightPart = bParts[index]!;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return Math.sign(aParts.length - bParts.length);
}

/** The feed app-update.yml names: only GitHub releases are read. */
export function parseReleaseFeed(
  appUpdateYml: string,
): { readonly owner: string; readonly repo: string } | null {
  const entries = new Map<string, string>();
  for (const line of appUpdateYml.split("\n")) {
    const match = /^(\w+):\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) entries.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ""));
  }
  const owner = entries.get("owner");
  const repo = entries.get("repo");
  if (entries.get("provider") !== "github" || !owner || !repo) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * The installable disk image in GitHub's "latest release" answer: a published, non-prerelease
 * release with `SSHCode-<version>-<arch>.dmg` and its `.sha256` beside it.
 */
export function releaseCandidate(release: unknown, arch: string): ReleaseCandidate | null {
  if (typeof release !== "object" || release === null) return null;
  const value = release as Record<string, unknown>;
  if (value.draft === true || value.prerelease === true) return null;
  if (typeof value.tag_name !== "string") return null;
  const version = value.tag_name.replace(/^v/, "");
  if (compareReleaseVersions(version, version) === null) return null;
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const asset = (name: string) =>
    assets.find(
      (entry): entry is { name: string; browser_download_url: string; size?: unknown } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { name?: unknown }).name === name &&
        typeof (entry as { browser_download_url?: unknown }).browser_download_url === "string",
    );
  const dmgName = `SSHCode-${version}-${arch}.dmg`;
  const dmg = asset(dmgName);
  const sha = asset(`${dmgName}.sha256`);
  if (!dmg || !sha) return null;
  return {
    version,
    notes: typeof value.body === "string" && value.body.trim() ? value.body : null,
    publishedAt: typeof value.published_at === "string" ? value.published_at : null,
    dmgUrl: dmg.browser_download_url,
    dmgSize: typeof dmg.size === "number" ? dmg.size : null,
    sha256Url: sha.browser_download_url,
  };
}

/** The bundle a Mac app runs from, or a reason it can't replace itself there. */
export function installTarget(
  execPath: string,
): { readonly app: string } | { readonly blocked: string } {
  const app = NodePath.resolve(execPath, "../../..");
  if (!app.endsWith(".app")) return { blocked: "SSHCode isn't running from an app bundle." };
  if (app.includes("/AppTranslocation/") || app.startsWith("/Volumes/")) {
    return {
      blocked:
        "Move SSHCode to your Applications folder and open it from there, then update again.",
    };
  }
  return { app };
}

/**
 * Waits for the app to exit, moves the new bundle into place (putting the old one back if that
 * fails), and opens it. Runs detached, so it outlives the app it replaces.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"; app="$2"; staged="$3"; backup="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 600 ] && exit 1
  sleep 0.1
done
if [ -d "$staged" ]; then
  rm -rf "$backup"
  if mv "$app" "$backup"; then
    if mv "$staged" "$app"; then
      rm -rf "$backup"
    else
      rm -rf "$app"
      mv "$backup" "$app"
    fi
  fi
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
open "$app" || { sleep 1; open -n "$app"; }
`;

export interface ReleaseDmgUpdaterDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<string>;
  readonly spawnDetached: (command: string, args: ReadonlyArray<string>) => void;
  readonly quit: () => void;
  readonly currentVersion: () => string;
  readonly arch: string;
  readonly execPath: string;
  readonly pid: number;
  readonly appUpdateYmlPath: string;
  /** Read when needed: Electron's userData path is settled after startup. */
  readonly updatesDir: () => string;
}

export type ReleaseDmgEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

/** A failure with a sentence the update menu can show as is. */
export class ReleaseUpdateError extends Error {
  override readonly name = "ReleaseUpdateError";
}

const USER_AGENT = "SSHCode-Updater";

function isNoSpaceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  if (code === "ENOSPC") return true;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && /no space left on device|\bENOSPC\b/i.test(message);
}

function toReleaseUpdateError(fallback: string, cause: unknown): ReleaseUpdateError {
  if (cause instanceof ReleaseUpdateError) return cause;
  if (isNoSpaceError(cause)) {
    return new ReleaseUpdateError("Not enough free disk space to download and unpack the update.", {
      cause,
    });
  }
  return new ReleaseUpdateError(fallback, { cause });
}

export function createReleaseDmgUpdater(deps: ReleaseDmgUpdaterDeps) {
  const listeners = new Map<string, Set<(...args: Array<unknown>) => void>>();
  const emit = (event: ReleaseDmgEvent, ...args: Array<unknown>) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  let available: ReleaseCandidate | null = null;
  let downloaded: { readonly version: string; readonly staged: string } | null = null;
  let downloading = false;

  const feed = async () => {
    const raw = await NodeFSP.readFile(deps.appUpdateYmlPath, "utf8").catch(() => null);
    const parsed = raw === null ? null : parseReleaseFeed(raw);
    if (!parsed) throw new ReleaseUpdateError("This build has no release feed to update from.");
    return parsed;
  };

  const checkForUpdates = async () => {
    emit("checking-for-update");
    const { owner, repo } = await feed();
    const response = await deps
      .fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      })
      .catch((cause) => {
        throw new ReleaseUpdateError("Couldn't reach GitHub to check for updates.", { cause });
      });
    if (response.status === 404) {
      available = null;
      emit("update-not-available", { version: deps.currentVersion() });
      return;
    }
    if (!response.ok) {
      throw new ReleaseUpdateError(`GitHub answered ${response.status} when checking for updates.`);
    }
    const payload = await response.json().catch((cause) => {
      throw new ReleaseUpdateError("GitHub returned an unreadable update response.", { cause });
    });
    const candidate = releaseCandidate(payload, deps.arch);
    const newer =
      candidate !== null &&
      (compareReleaseVersions(candidate.version, deps.currentVersion()) ?? 0) > 0;
    if (!candidate || !newer) {
      available = null;
      emit("update-not-available", { version: deps.currentVersion() });
      return;
    }
    available = candidate;
    if (downloaded !== null && downloaded.version !== candidate.version) {
      const stale = downloaded;
      downloaded = null;
      await NodeFSP.rm(NodePath.dirname(stale.staged), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    emit("update-available", {
      version: candidate.version,
      releaseNotes: candidate.notes ?? undefined,
      releaseDate: candidate.publishedAt ?? undefined,
    });
  };

  const download = async (url: string, file: string, size: number | null) => {
    const response = await deps
      .fetch(url, { headers: { "User-Agent": USER_AGENT } })
      .catch((cause) => {
        throw new ReleaseUpdateError("Couldn't reach GitHub to download the update.", { cause });
      });
    if (!response.ok || !response.body) {
      throw new ReleaseUpdateError(`GitHub answered ${response.status} for the update download.`);
    }
    const headerLength = Number(response.headers.get("content-length"));
    const expectedLength = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : null;
    const total = expectedLength ?? size ?? 0;
    const hash = NodeCrypto.createHash("sha256");
    const handle = await NodeFSP.open(file, "w").catch((cause) => {
      throw toReleaseUpdateError("Couldn't create the update download file.", cause);
    });
    let transferred = 0;
    try {
      const reader = (response.body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      while (true) {
        const next = await reader.next().catch((cause) => {
          throw new ReleaseUpdateError("The update download was interrupted before it finished.", {
            cause,
          });
        });
        if (next.done) break;
        const chunk = next.value;
        hash.update(chunk);
        transferred += chunk.byteLength;
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle
            .write(chunk, offset, chunk.byteLength - offset)
            .catch((cause) => {
              throw toReleaseUpdateError("Couldn't write the downloaded update to disk.", cause);
            });
          offset += bytesWritten;
        }
        if (total > 0) {
          emit("download-progress", {
            percent: Math.min(100, (transferred / total) * 100),
            transferred,
            total,
          });
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (expectedLength !== null && transferred !== expectedLength) {
      throw new ReleaseUpdateError("The update download ended before it finished.");
    }
    return hash.digest("hex");
  };

  const plistValue = (app: string, key: string) =>
    deps
      .run("plutil", ["-extract", key, "raw", NodePath.join(app, "Contents/Info.plist")])
      .then((value) => value.trim());

  const downloadUpdate = async () => {
    if (downloading) throw new ReleaseUpdateError("An update download is already in progress.");
    const release = available;
    if (!release) throw new ReleaseUpdateError("Check for updates before downloading.");
    const target = installTarget(deps.execPath);
    if ("blocked" in target) throw new ReleaseUpdateError(target.blocked);
    const writable = await NodeFSP.access(NodePath.dirname(target.app), NodeFS.constants.W_OK)
      .then(() => NodeFSP.access(target.app, NodeFS.constants.W_OK))
      .then(() => true)
      .catch(() => false);
    if (!writable) {
      throw new ReleaseUpdateError(
        `SSHCode can't replace itself in ${NodePath.dirname(target.app)}. Download the new version from GitHub instead.`,
      );
    }

    downloading = true;
    try {
      const shaResponse = await deps
        .fetch(release.sha256Url, { headers: { "User-Agent": USER_AGENT } })
        .catch((cause) => {
          throw new ReleaseUpdateError("Couldn't reach GitHub for the update checksum.", { cause });
        });
      if (!shaResponse.ok) {
        throw new ReleaseUpdateError(
          `GitHub answered ${shaResponse.status} for the update checksum.`,
        );
      }
      const expected = ((await shaResponse.text()).trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) {
        throw new ReleaseUpdateError("The release has no usable SHA-256 checksum.");
      }

      const updatesRoot = deps.updatesDir();
      const dir = NodePath.join(updatesRoot, release.version);
      await NodeFSP.rm(dir, { recursive: true, force: true });
      await NodeFSP.mkdir(dir, { recursive: true }).catch((cause) => {
        throw toReleaseUpdateError("Couldn't prepare the update folder.", cause);
      });
      const dmg = NodePath.join(dir, "update.dmg");

      try {
        const actual = await download(release.dmgUrl, dmg, release.dmgSize);
        if (actual !== expected) {
          throw new ReleaseUpdateError(
            "The downloaded update didn't match its published checksum.",
          );
        }

        const mount = NodePath.join(dir, "mount");
        const staged = NodePath.join(dir, NodePath.basename(target.app));
        await NodeFSP.mkdir(mount, { recursive: true });
        await deps
          .run("hdiutil", [
            "attach",
            dmg,
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
            mount,
          ])
          .catch((cause) => {
            throw toReleaseUpdateError("Couldn't open the downloaded disk image.", cause);
          });
        try {
          const bundle = (await NodeFSP.readdir(mount)).find((name) => name.endsWith(".app"));
          if (!bundle) throw new ReleaseUpdateError("The update's disk image holds no app.");
          await deps.run("ditto", [NodePath.join(mount, bundle), staged]).catch((cause) => {
            throw toReleaseUpdateError("Couldn't unpack the downloaded app.", cause);
          });
        } finally {
          await deps
            .run("hdiutil", ["detach", mount, "-quiet"])
            .catch(() =>
              deps.run("hdiutil", ["detach", mount, "-quiet", "-force"]).catch(() => ""),
            );
          await NodeFSP.rm(mount, { recursive: true, force: true }).catch(() => undefined);
        }
        await deps.run("codesign", ["--verify", "--deep", "--strict", staged]).catch(() => {
          throw new ReleaseUpdateError("The downloaded app failed its code signature check.");
        });
        const [id, currentId, version] = await Promise.all([
          plistValue(staged, "CFBundleIdentifier"),
          plistValue(target.app, "CFBundleIdentifier"),
          plistValue(staged, "CFBundleShortVersionString"),
        ]).catch((cause) => {
          throw toReleaseUpdateError("Couldn't verify the downloaded app's version.", cause);
        });
        if (id !== currentId || version !== release.version) {
          throw new ReleaseUpdateError("The downloaded app isn't the expected SSHCode version.");
        }
        await NodeFSP.rm(dmg, { force: true });
        // Drop any older staged versions once the new one is verified on disk.
        const entries = await NodeFSP.readdir(updatesRoot).catch(() => []);
        await Promise.all(
          entries
            .filter((entry) => entry !== release.version)
            .map((entry) =>
              NodeFSP.rm(NodePath.join(updatesRoot, entry), { recursive: true, force: true }).catch(
                () => undefined,
              ),
            ),
        );
        downloaded = { version: release.version, staged };
        emit("update-downloaded", {
          version: release.version,
          releaseNotes: release.notes ?? undefined,
          releaseDate: release.publishedAt ?? undefined,
        });
      } catch (error) {
        await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw toReleaseUpdateError("Couldn't download and unpack the update.", error);
      }
    } finally {
      downloading = false;
    }
  };

  const quitAndInstall = () => {
    const ready = downloaded;
    if (!ready) throw new ReleaseUpdateError("No downloaded update to install.");
    if (!NodeFS.existsSync(ready.staged)) {
      downloaded = null;
      throw new ReleaseUpdateError(
        "The downloaded update is no longer on disk. Download it again.",
      );
    }
    const target = installTarget(deps.execPath);
    if ("blocked" in target) throw new ReleaseUpdateError(target.blocked);
    try {
      NodeFS.accessSync(NodePath.dirname(target.app), NodeFS.constants.W_OK);
      NodeFS.accessSync(target.app, NodeFS.constants.W_OK);
    } catch {
      throw new ReleaseUpdateError(
        `SSHCode can't replace itself in ${NodePath.dirname(target.app)}. Download the new version from GitHub instead.`,
      );
    }
    const updatesRoot = deps.updatesDir();
    const script = NodePath.join(updatesRoot, "install.sh");
    try {
      NodeFS.mkdirSync(updatesRoot, { recursive: true });
      NodeFS.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
    } catch (cause) {
      throw toReleaseUpdateError("Couldn't prepare the update installer.", cause);
    }
    const backup = NodePath.join(updatesRoot, "previous.app");
    deps.spawnDetached("/bin/sh", [script, String(deps.pid), target.app, ready.staged, backup]);
    deps.quit();
  };

  return {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    on: (event: string, listener: (...args: Array<unknown>) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  };
}

/** Runs a command and resolves its stdout; rejects with its first stderr line. */
export function runCommand(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).split("\n")[0] || error.message));
        else resolve(String(stdout));
      },
    );
  });
}

export function spawnDetached(command: string, args: ReadonlyArray<string>): void {
  NodeChildProcess.spawn(command, [...args], { detached: true, stdio: "ignore" }).unref();
}
