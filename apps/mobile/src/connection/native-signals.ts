import { Connectivity, Wakeups, type NetworkStatus } from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as RcRef from "effect/RcRef";
import * as Stream from "effect/Stream";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";
import { mobileNetworkChanged } from "./network-changes";

function networkStatus(state: Network.NetworkState): NetworkStatus {
  return state.isConnected === false
    ? "offline"
    : state.isConnected === true
      ? "online"
      : "unknown";
}

/** All supervisors and stream consumers share one pair of native listeners. */
export const make = Effect.gen(function* () {
  let status: NetworkStatus = "unknown";
  const listeners = yield* RcRef.make({
    acquire: Effect.gen(function* () {
      // Replay the current path to a newly opened environment. Wakeups are edges.
      const paths = yield* PubSub.sliding<NetworkStatus>({ capacity: 32, replay: 1 });
      const wakeups = yield* PubSub.sliding<Wakeups.ConnectionWakeup>(32);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let active = true;
          let revision = 0;
          let previous: Network.NetworkState | undefined;
          let backgroundedAtMs = AppState.currentState === "background" ? Date.now() : null;
          const record = (state: Network.NetworkState) => {
            if (!active) return;
            revision++;
            status = networkStatus(state);
            PubSub.publishUnsafe(paths, status);
            if (mobileNetworkChanged(previous, state)) {
              PubSub.publishUnsafe(wakeups, "network-changed");
            }
            previous = state;
          };
          const refresh = () => {
            const started = ++revision;
            void Network.getNetworkStateAsync()
              .then((state) => {
                // A listener update or a later foreground read supersedes this sample.
                if (revision === started) record(state);
              })
              .catch(() => undefined);
          };
          const network = Network.addNetworkStateListener(record);
          const appState = AppState.addEventListener("change", (state) => {
            if (state === "background") backgroundedAtMs = Date.now();
            if (state !== "active") return;
            refresh();
            PubSub.publishUnsafe(
              wakeups,
              mobileApplicationActiveWakeup(backgroundedAtMs, Date.now()),
            );
            backgroundedAtMs = null;
          });
          if (previous === undefined) refresh();
          return () => {
            active = false;
            status = "unknown";
            network.remove();
            appState.remove();
          };
        }),
        (close) => Effect.sync(close),
      );
      return { paths, wakeups };
    }),
  });
  return Context.make(Connectivity.Connectivity, {
    // On iOS an explicit read starts a path monitor and can take five seconds.
    // Cache hydration and connection setup can start while the first sample arrives.
    status: Effect.sync(() => status),
    changes: Stream.unwrap(
      RcRef.get(listeners).pipe(Effect.map(({ paths }) => Stream.fromPubSub(paths))),
    ),
  }).pipe(
    Context.add(Wakeups.ConnectionWakeups, {
      changes: Stream.unwrap(
        RcRef.get(listeners).pipe(Effect.map(({ wakeups }) => Stream.fromPubSub(wakeups))),
      ),
    }),
  );
});
