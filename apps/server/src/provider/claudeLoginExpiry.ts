// @effect-diagnostics nodeBuiltinImport:off -- the keychain account is the OS user, like Claude Code's.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * When a regular Claude login (`claude auth login`) runs out. Claude Code
 * keeps the refresh token's expiry next to the tokens: in the macOS keychain,
 * elsewhere in `<config>/.credentials.json`. Only that date is read; the
 * tokens are dropped at once and never logged.
 *
 * A login lasts about four weeks. Claude Code itself warns three days ahead,
 * but only in its terminal UI, which nobody sees when SSHCode runs it.
 */

/**
 * Claude Code's keychain entry: "Claude Code-credentials", plus a short hash
 * of the config folder when CLAUDE_CONFIG_DIR picks one.
 */
export function claudeCredentialsService(configDir: string | undefined): string {
  if (configDir === undefined) return "Claude Code-credentials";
  const hash = NodeCrypto.createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** A stored regular login. Its expiry is unset when it does not record one. */
export interface StoredClaudeLogin {
  readonly expiresAt: number | undefined;
}

/** Unset when no login is stored. */
export function storedLoginFromCredentials(stored: string): StoredClaudeLogin | undefined {
  try {
    const parsed = JSON.parse(stored) as {
      readonly claudeAiOauth?: {
        readonly accessToken?: unknown;
        readonly refreshToken?: unknown;
        readonly refreshTokenExpiresAt?: unknown;
      };
    };
    const oauth = parsed.claudeAiOauth;
    if (typeof oauth?.refreshToken !== "string" && typeof oauth?.accessToken !== "string") {
      return undefined;
    }
    const expiresAt = oauth.refreshTokenExpiresAt;
    return {
      expiresAt:
        typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The refresh token's expiry in a stored login, in epoch milliseconds. */
export function loginExpiryFromCredentials(stored: string): number | undefined {
  return storedLoginFromCredentials(stored)?.expiresAt;
}

/** Unset when no login is stored, or when it cannot be read. */
export const readClaudeLogin = Effect.fn("readClaudeLogin")(function* (
  configDir: string | undefined,
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const stored = yield* spawner
      .string(
        ChildProcess.make(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-s",
            claudeCredentialsService(configDir),
            "-a",
            NodeOS.userInfo().username,
            "-w",
          ],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => ""),
      );
    return storedLoginFromCredentials(stored);
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const stored = yield* fileSystem
    .readFileString(path.join(configDir ?? path.join(home, ".claude"), ".credentials.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  return storedLoginFromCredentials(stored);
});

/** Unset when the login is missing or does not record its expiry. */
export const readClaudeLoginExpiry = (configDir: string | undefined) =>
  readClaudeLogin(configDir).pipe(Effect.map((login) => login?.expiresAt));

const HOUR_MS = 3_600_000;
/** Each warning goes out once, when the login has this little time left. */
export const LOGIN_EXPIRY_WARNINGS_MS = [48 * HOUR_MS, 6 * HOUR_MS] as const;

/** The warning due now, or none: the tightest threshold the login has crossed. */
export function dueLoginExpiryWarning(expiresAtMs: number, nowMs: number): number | undefined {
  const left = expiresAtMs - nowMs;
  if (left <= 0) return undefined;
  return LOGIN_EXPIRY_WARNINGS_MS.findLast((threshold) => left <= threshold);
}
