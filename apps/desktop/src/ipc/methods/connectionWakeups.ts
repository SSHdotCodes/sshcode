import type { DesktopConnectionWakeupReason } from "@t3tools/contracts";
import * as Electron from "electron";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopNetworkInterfaces from "../../backend/DesktopNetworkInterfaces.ts";
import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import { CONNECTION_WAKEUP_CHANNEL } from "../channels.ts";

export const NETWORK_INTERFACE_POLL_INTERVAL = Duration.seconds(5);

function isLinkLocalAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized.startsWith("169.254.") || normalized.startsWith("fe80:");
}

/**
 * Stable fingerprint of active non-internal, non-link-local network addresses.
 * Captures Wi-Fi switches, ethernet plug/unplug, VPN and Tailscale interface
 * transitions without spawning subprocesses.
 */
export function networkInterfacesFingerprint(
  interfaces: DesktopNetworkInterfaces.NetworkInterfaces,
): string {
  const entries: string[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (addresses === undefined) continue;
    for (const info of addresses) {
      if (info.internal || isLinkLocalAddress(info.address)) continue;
      entries.push(`${name}:${String(info.family)}:${info.address}`);
    }
  }
  entries.sort();
  return entries.join("\n");
}

function broadcastToWindows(reason: DesktopConnectionWakeupReason): void {
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(CONNECTION_WAKEUP_CHANNEL, reason);
    }
  }
}

export interface InstallConnectionWakeupsOptions {
  readonly broadcast?: (reason: DesktopConnectionWakeupReason) => void;
  readonly pollInterval?: Duration.Duration;
}

/**
 * Forwards OS sleep resume, screen unlock, and network interface changes to
 * open renderer windows so connection supervisors probe or reconnect right
 * away instead of waiting for socket ping timeouts.
 */
export const installConnectionWakeups = Effect.fn("desktop.ipc.installConnectionWakeups")(
  function* (options?: InstallConnectionWakeupsOptions) {
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
    const broadcast = options?.broadcast ?? broadcastToWindows;
    const pollInterval = options?.pollInterval ?? NETWORK_INTERFACE_POLL_INTERVAL;

    const fingerprintRef = yield* Ref.make<string | undefined>(undefined);

    const checkNetworkChange = Effect.gen(function* () {
      const next = networkInterfacesFingerprint(yield* networkInterfaces.read);
      const changed = yield* Ref.modify(fingerprintRef, (previous) => [
        previous !== undefined && previous !== next,
        next,
      ]);
      if (changed) {
        broadcast("network-changed");
      }
    }).pipe(Effect.catchCause(() => Effect.void));

    // If the first interface read fails, the first successful read sets the baseline.
    yield* checkNetworkChange;
    const runCheck = Effect.runForkWith(yield* Effect.context<never>());

    yield* powerMonitor.onSimpleEvent("resume", () => {
      broadcast("resume");
      runCheck(checkNetworkChange);
    });
    yield* powerMonitor.onSimpleEvent("unlock-screen", () => {
      broadcast("unlock-screen");
      runCheck(checkNetworkChange);
    });

    yield* Stream.tick(pollInterval).pipe(
      Stream.drop(1),
      Stream.runForEach(() => checkNetworkChange),
      Effect.forkScoped,
    );
  },
);
