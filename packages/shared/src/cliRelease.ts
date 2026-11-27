/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

import type { ServerSelfUpdateCapability } from "@t3tools/contracts";
import * as Context from "effect/Context";

// SSHCode's own releases: `update` on a headless host must never install upstream T3 Code.
const CLI_RELEASE_REPOSITORY = "SSHdotCodes/sshcode";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";

/**
 * Whether this build's GitHub releases carry the server downloads: the `t3-<version>-<platform>`
 * archives and their `SHA256SUMS`. False turns off every flow that needs them (SSH environments,
 * `sshcode update`, `sshcode service install|update`, updating a server that downloads its
 * update) with {@link SERVER_DOWNLOADS_UNAVAILABLE} in their place. Flip it in the release that
 * starts shipping the downloads.
 */
export const SERVER_DOWNLOADS_PUBLISHED = false;

/** {@link SERVER_DOWNLOADS_PUBLISHED} for Effect code; tests provide either value. */
export class ServerDownloadsPublished extends Context.Reference<boolean>(
  "t3/serverDownloadsPublished",
  { defaultValue: () => SERVER_DOWNLOADS_PUBLISHED },
) {}

/** Said wherever a flow needs the server download this build's releases do not carry. */
export const SERVER_DOWNLOADS_UNAVAILABLE =
  "Not available yet: SSHCode's releases don't include the server download this needs, so run the server from a source checkout instead.";

/** The sentence to show instead of a flow that needs the server download, or null when it can run. */
export function serverDownloadsUnavailable(
  published: boolean = SERVER_DOWNLOADS_PUBLISHED,
): string | null {
  return published ? null : SERVER_DOWNLOADS_UNAVAILABLE;
}

/**
 * {@link serverDownloadsUnavailable} for updating a server: only the desktop app's own update
 * works without the download, so it is never refused here.
 */
export function serverUpdateUnavailable(
  selfUpdate: ServerSelfUpdateCapability | null | undefined,
  published: boolean = SERVER_DOWNLOADS_PUBLISHED,
): string | null {
  return selfUpdate === "boot-service" || selfUpdate === "respawn"
    ? serverDownloadsUnavailable(published)
    : null;
}
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

/**
 * The archives a release attaches. Kept in step with the build_linux_cli
 * matrix, build_windows_arm64_cli, and the `cli_archive` rows in
 * .github/workflows/release.yml: a key here without a build there produces
 * download URLs that 404, and a build there without a key here is
 * unreachable from every installer.
 */
// No darwin-x64: Node single-executables are unsupported on x64 macOS (the
// SEA docs list macOS as arm64 only) and the binary segfaults on start.
export const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: string,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * The tar to extract a release archive with. Windows ships bsdtar in
 * System32, which reads both formats; a Git-for-Windows GNU tar earlier on
 * PATH cannot open the zip, so the system copy is named by absolute path.
 */
export function cliArchiveTarCommand(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

/** Directory that `releases/download/<tag>/<asset>` lives under. */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

/**
 * Parses the `sha256sum` style checksum file attached to each release.
 * Lines are `<hex>  <file>`; a leading `*` marks binary mode and is ignored.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

/** The release train a version was published on, derived from its prerelease tag. */
export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * One page of GitHub's list-releases endpoint, newest first. Callers walk pages
 * until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/**
 * GitHub's record of one release, listing its assets. Drafts are not visible
 * here without credentials, so an unpublished release reads as missing.
 */
export function cliReleaseTagUrl(version: string): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(version)}`;
}

/**
 * Picks the newest version on a channel from the release index. Tags are
 * `v<version>`; the channel is decided by the same rule the runtime uses, so
 * a preview tag never satisfies a nightly lookup and vice versa. Drafts are
 * skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
