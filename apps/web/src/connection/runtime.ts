import { Connection, ConnectionTimings } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
  ThreadMediaHistory,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as Runtime from "../lib/runtime";
import * as BackgroundActivityReporter from "../lib/backgroundActivityReporter";
import * as ConnectionPlatform from "./platform";

/** Shared between the session's initial config stream and `serverEnvironment` so both reuse one stream. */
export const WEB_SERVER_CONFIG_SUBSCRIPTION_OPTIONS = {
  environmentThemes: true,
  chatTabs: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
  compactProviders: true,
} as const;

/**
 * Desktop/web connection timings. Hedging to the next saved route after 1.5s of
 * receive silence prevents a blackholed LAN/Tailscale/SSH route from stalling
 * remote failover for the full 15s establishment timeout.
 */
export const WEB_CONNECTION_TIMINGS: ConnectionTimings.ConnectionTimingsShape = {
  ...ConnectionTimings.DEFAULT_CONNECTION_TIMINGS,
  routeFallbackDelayMs: 1_500,
};

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  // The saved list shows at launch either way; resuming from its cursor skips
  // refetching every chat before the server's replay catches it up.
  ShellSnapshotLoader.layerWithOptions({ resumeCachedSnapshot: true }),
  ThreadHistoryController.layer,
  ThreadMediaHistory.mediaLayer,
  PullRequestDiffLoader.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivityReporter.layerObserver
  | typeof BackgroundActivityReporter.layer;

const layerProvidedClientConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      ...WEB_SERVER_CONFIG_SUBSCRIPTION_OPTIONS,
      heldCatalogs: true,
      timings: WEB_CONNECTION_TIMINGS,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Runtime.layer,
      layerProvidedConnectionPlatform,
      BackgroundActivityReporter.layerObserver,
    ),
  ),
);

const layerConnection = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(layerProvidedClientConnection),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerConnection);
