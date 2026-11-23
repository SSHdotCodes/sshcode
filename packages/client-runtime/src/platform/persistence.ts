import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import type { DeferredShellSnapshot } from "../state/shellPullRequests.ts";
import type { ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";

export interface CachedThreadPreview {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export class ConnectionPersistenceError extends Schema.TaggedError<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "list-disabled-targets",
      "register-connection",
      "set-connection-routes",
      "remove-connection",
      "set-connection-enabled",
      "load-shell",
      "save-shell",
      "load-thread",
      "save-thread",
      "remove-thread",
      "load-thread-preview",
      "load-server-config",
      "save-server-config",
      "load-vcs-refs",
      "save-vcs-refs",
      "remove-vcs-refs",
      "clear-vcs-refs",
      "clear-environment",
    ]),
    message: Schema.String,
  },
) {}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
    /** Saved environments the user switched off. See `ConnectionRegistrationStore.setEnabled`. */
    readonly listDisabled: Effect.Effect<ReadonlyArray<EnvironmentId>, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    /**
     * Saves one route's records and sets the environment's full route list,
     * preferred first. Records of routes missing from `routes` are dropped.
     */
    readonly register: (
      registration: ConnectionRegistration,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /** Reorders or drops routes without adding one. `routes` must not be empty. */
    readonly setRoutes: (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /** Forgets the environment and every route it had. */
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

export interface ShellPreviewCounts {
  readonly visibleChats: number;
  readonly needsYou: number;
  readonly unread: boolean;
  readonly working: number;
  readonly pendingInput: number;
}

export interface EnvironmentShellPreview extends OrchestrationV2ShellSnapshot {
  readonly previewCounts?: ShellPreviewCounts;
}

export class EnvironmentCacheStore extends Context.Service<
  EnvironmentCacheStore,
  {
    /** Display-only first screen. Never used as a synchronization baseline. */
    readonly loadShellPreview?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<EnvironmentShellPreview>, ConnectionPersistenceError>;
    /** Platform yield after publishing the display-only preview. */
    readonly yieldAfterShellPreview?: Effect.Effect<void>;
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<DeferredShellSnapshot>, ConnectionPersistenceError>;
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ShellSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationV2ThreadDetailSnapshot>,
      ConnectionPersistenceError
    >;
    /** Display-only tail, atomically saved with the full cache. Never a resume baseline. */
    readonly loadThreadFirstScreen?: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationV2ThreadDetailSnapshot>,
      ConnectionPersistenceError
    >;
    readonly yieldAfterThreadFirstScreen?: Effect.Effect<void>;
    readonly saveThread: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ThreadDetailSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /** Keep an open thread's offline snapshot out of cache eviction until its scope closes. */
    readonly retainThread?: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Display-only: the cached thread's last user or assistant message, read
     * without decoding the whole snapshot (hover cards ask for many threads).
     */
    readonly loadThreadPreview?: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<CachedThreadPreview>, ConnectionPersistenceError>;
    readonly removeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * The last complete server configuration. This deliberately includes provider
     * metadata so offline task creation can still offer the models a user last saw.
     */
    readonly loadServerConfig: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ServerConfig>, ConnectionPersistenceError>;
    readonly saveServerConfig: (
      environmentId: EnvironmentId,
      config: ServerConfig,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * The unfiltered branch list for a workspace. Query-specific lists are not
     * cached because they are incomplete and unsafe to present as a full picker.
     */
    readonly loadVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<Option.Option<VcsListRefsResult>, ConnectionPersistenceError>;
    readonly saveVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
      refs: VcsListRefsResult,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * Removes every persisted branch-list snapshot for an environment. Git ref
     * mutations are repository-wide, and linked worktrees may have cached the
     * same refs under different working-directory keys.
     */
    readonly clearVcsRefs: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /** Last route id that connected to this environment, to skip waiting on silent higher routes. */
    readonly loadLastRoute?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<string>, ConnectionPersistenceError>;
    readonly saveLastRoute?: (
      environmentId: EnvironmentId,
      routeId: string,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clear: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/EnvironmentCacheStore") {}

export class EnvironmentOwnedDataCleanup extends Context.Reference<{
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
}>("@t3tools/client-runtime/platform/persistence/EnvironmentOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
