/**
 * RemoteOpenTargets - resolves the SSH hostnames this environment advertises
 * for remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`).
 *
 * The server can only check itself: sshd listening locally, tailscaled
 * reporting a MagicDNS name and whether Tailscale SSH is on, and the machine
 * hostname for mDNS. Whether a given name resolves from the viewer's machine
 * is inherently client-side.
 * Targets are ordered most-reachable first (tailnet name works from anywhere
 * on the tailnet; `<hostname>.local` only on the same LAN).
 */
import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SSH_PORT = 22;

/**
 * Every client connect reads these targets for its config snapshot, and each
 * read spawns the `tailscale` CLI. sshd and Tailscale SSH rarely change, so
 * connects within this window share one read.
 */
const TARGETS_CACHE_TTL = "60 seconds";

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  const resolveTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );

    // Tailscale absent or down is the common case, not an error.
    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH answers on the tailnet name with no local sshd, so only
      // that name can work. A running tailscaled alone is not an SSH route.
      // With neither, advertise nothing so clients render a clear "no SSH
      // route" state instead of links that hang.
      if (
        magicDnsName !== null &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        targets.push({ kind: "tailscale", host: magicDnsName });
      }
      return targets;
    }

    if (magicDnsName !== null) {
      targets.push({ kind: "tailscale", host: magicDnsName });
    }

    // os.hostname() may already be an FQDN (macOS often reports
    // "Name.local"); mDNS names are always `<first-label>.local`.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({ kind: "mdns", host: `${shortHostname}.local` });
    }

    return targets;
  });

  // One shared read per window; a connect that gives up does not cancel it for the others.
  const cachedTargets = yield* Effect.cachedWithTTL(resolveTargets, TARGETS_CACHE_TTL);

  return RemoteOpenTargets.of({ resolveTargets: () => cachedTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
