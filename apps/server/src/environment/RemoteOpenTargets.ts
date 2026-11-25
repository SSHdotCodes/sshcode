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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SSH_PORT = 22;

/**
 * Every client connect reads these targets for its config snapshot, and each
 * read spawns the `tailscale` CLI. sshd and Tailscale SSH rarely change, so
 * connects within this window share one read and expired reconnects return the
 * last known targets immediately while refreshing in the background.
 */
const TARGETS_CACHE_TTL_NANOS = 60_000_000_000n;

interface TargetsCacheEntry {
  readonly scan: Deferred.Deferred<ReadonlyArray<RemoteOpenTarget>>;
  /** Undefined while a refresh is still running. */
  readonly expiresAtNanos: bigint | undefined;
  /** Last resolved targets for stale-while-revalidate reconnects. */
  readonly value: ReadonlyArray<RemoteOpenTarget> | undefined;
}

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
  const scope = yield* Scope.Scope;

  const resolveTargets = (hostname: string) =>
    Effect.gen(function* () {
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
      const shortHostname = hostname.split(".")[0]?.trim();
      if (shortHostname !== undefined && shortHostname.length > 0) {
        targets.push({ kind: "mdns", host: `${shortHostname}.local` });
      }

      return targets;
    });

  const targetsCache = yield* Ref.make<Option.Option<TargetsCacheEntry>>(Option.none());
  const runTargetsDiscovery = (
    scan: Deferred.Deferred<ReadonlyArray<RemoteOpenTarget>>,
    hostname: string,
  ) =>
    resolveTargets(hostname).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const expiresAtNanos = (yield* Clock.monotonicTimeNanos) + TARGETS_CACHE_TTL_NANOS;
          yield* Ref.update(targetsCache, (current) =>
            Option.isNone(current) || current.value.scan !== scan
              ? current
              : Exit.isSuccess(exit)
                ? Option.some({ scan, expiresAtNanos, value: exit.value })
                : Option.none(),
          );
          yield* Deferred.done(scan, exit);
        }),
      ),
      Effect.interruptible,
      Effect.forkIn(scope, { startImmediately: true }),
    );

  // One shared read per window; expired reconnects return the last known
  // targets immediately and refresh in the background so `subscribeServerConfig`
  // never stalls waiting on `tailscale status`.
  const cachedTargets = Effect.gen(function* () {
    const hostname = yield* HostProcess.Hostname;
    const nowNanos = yield* Clock.monotonicTimeNanos;
    const action = yield* Ref.modify(
      targetsCache,
      (
        current,
      ): [
        (
          | {
              readonly _tag: "return";
              readonly value: ReadonlyArray<RemoteOpenTarget>;
              readonly start?: Deferred.Deferred<ReadonlyArray<RemoteOpenTarget>>;
            }
          | {
              readonly _tag: "await";
              readonly scan: Deferred.Deferred<ReadonlyArray<RemoteOpenTarget>>;
              readonly start?: Deferred.Deferred<ReadonlyArray<RemoteOpenTarget>>;
            }
        ),
        Option.Option<TargetsCacheEntry>,
      ] => {
        if (Option.isSome(current)) {
          const entry = current.value;
          if (entry.expiresAtNanos === undefined || entry.expiresAtNanos > nowNanos) {
            return [
              entry.value !== undefined
                ? { _tag: "return", value: entry.value }
                : { _tag: "await", scan: entry.scan },
              current,
            ];
          }
          if (entry.value !== undefined) {
            const scan = Deferred.makeUnsafe<ReadonlyArray<RemoteOpenTarget>>();
            return [
              { _tag: "return", value: entry.value, start: scan },
              Option.some({ scan, expiresAtNanos: undefined, value: entry.value }),
            ];
          }
        }
        const scan = Deferred.makeUnsafe<ReadonlyArray<RemoteOpenTarget>>();
        return [
          { _tag: "await", scan, start: scan },
          Option.some({ scan, expiresAtNanos: undefined, value: undefined }),
        ];
      },
    );
    if (action.start !== undefined) {
      yield* runTargetsDiscovery(action.start, hostname);
    }
    return action;
  }).pipe(
    Effect.uninterruptible,
    Effect.flatMap((action) =>
      action._tag === "return" ? Effect.succeed(action.value) : Deferred.await(action.scan),
    ),
  );

  return RemoteOpenTargets.of({ resolveTargets: () => cachedTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
