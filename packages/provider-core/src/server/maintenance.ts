import type * as Effect from "effect/Effect";
import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version reported by the installer that owns the executable.
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
  readonly latestVersion?: string | null;
  /**
   * Where the installer that owns the executable publishes its newest version
   * as plain text, for installers whose channel trails npm. Used when
   * `latestVersion` is unset.
   */
  readonly latestVersionUrl?: string;
  /** Copyable instructions when this installation cannot be updated in-app. */
  readonly manualUpdateCommand?: string;
  /** Optional installed CLI version for SDK-backed drivers with a separate CLI. */
  readonly installedVersion?: string | null;
  /** Compare native release revisions when the provider does not use plain semver. */
  readonly compareVersions?: (current: string, latest: string) => number;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * Extra environment for the spawned updater, on top of the server's own.
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Managed installers run inside the same click-only lock and verification flow. */
  readonly run?: Effect.Effect<void, Error>;
}
