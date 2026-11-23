import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import Constants from "expo-constants";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as MobileStorage from "../persistence/mobile-storage";
import { appAtomRegistry } from "../state/atom-registry";
import * as EnvironmentOwnedDataCleanup from "./environment-owned-data-cleanup";
import * as NativeSignals from "./native-signals";
import * as ConnectionStorage from "./storage";

const layerSignals = Layer.effectContext(
  Effect.gen(function* () {
    const native = yield* NativeSignals.make;
    const wakeups = Context.get(native, Wakeups.ConnectionWakeups);
    const changes = yield* Stream.mergeAll(
      [
        wakeups.changes,
        managedRelayAccountChanges(appAtomRegistry).pipe(
          Stream.map(() => "credentials-changed" as const),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Stream.share({ capacity: 32, idleTimeToLive: 0 }));
    return native.pipe(Context.add(Wakeups.ConnectionWakeups, { changes }));
  }),
);

const layerCapabilities = Layer.effectContext(
  Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    return Context.make(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.sync(() =>
          Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
        ),
        clerkToken: Effect.gen(function* () {
          const session = appAtomRegistry.get(managedRelaySessionAtom);
          if (session === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "Sign in to T3 Connect to connect this environment.",
              source: "cloud-session",
            });
          }
          const token = yield* session.readClerkToken().pipe(
            Effect.mapError(
              (error) =>
                new ConnectionTransientError({
                  reason: "network",
                  detail: error.message,
                  source: "cloud-session",
                }),
            ),
          );
          if (token === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "The T3 Connect session is unavailable.",
              source: "cloud-session",
            });
          }
          return token;
        }),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.PrimaryEnvironmentAuth,
        ClientCapabilities.PrimaryEnvironmentAuth.of({
          bearerToken: Effect.succeed(Option.none()),
        }),
      ),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({
          deviceId: storage.loadOrCreateAgentAwarenessDeviceId.pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: `Could not load the mobile device identity: ${String(cause)}`,
                }),
            ),
            Effect.map(Option.some),
          ),
        }),
      ),
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({
          metadata: authClientMetadata(Constants.expoConfig?.version),
        }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          prepare: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          disconnect: () => Effect.void,
        }),
      ),
    );
  }),
);

const layerPlatformConnectionSource = Layer.succeed(
  PlatformConnectionSource.PlatformConnectionSource,
  PlatformConnectionSource.PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const layerProvidedConnectionStorage = ConnectionStorage.layer.pipe(Layer.provide(Runtime.layer));
const layerProvidedCapabilities = layerCapabilities.pipe(Layer.provide(Runtime.layer));

type ConnectionPlatformLayerSource =
  | typeof layerProvidedConnectionStorage
  | typeof Runtime.layer
  | typeof layerSignals
  | typeof layerProvidedCapabilities
  | typeof layerPlatformConnectionSource
  | typeof EnvironmentOwnedDataCleanup.layer;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  layerProvidedConnectionStorage,
  Runtime.layer,
  layerSignals,
  layerProvidedCapabilities,
  layerPlatformConnectionSource,
  EnvironmentOwnedDataCleanup.layer,
);
