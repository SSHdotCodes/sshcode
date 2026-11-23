import {
  ComputerUseError,
  type ComputerAction,
  type ComputerApp,
  type ComputerDriverStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";

// Only the MIT driver CLI is extracted. Spaces, perception, SDKs and installers
// are deliberately absent from the local installation.
const VERSION = "0.38.0";
const ARCHIVE = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
const ARCHIVE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ARCHIVE}`;
const ARCHIVE_SHA256 = "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732";
const MAX_TREE_CHARS = 24_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_APPS = 200;
const MIT_LICENSE = `MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const AppRecord = Schema.Struct({
  name: Schema.String,
  pid: Schema.Int,
  bundle_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  running: Schema.Boolean,
  active: Schema.Boolean,
});
const AppsOutput = Schema.Struct({ apps: Schema.Array(AppRecord) });
const WindowRecord = Schema.Struct({
  pid: Schema.NullOr(Schema.Int),
  window_id: Schema.Int,
  title: Schema.String,
  is_on_screen: Schema.Boolean,
  z_index: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  bounds: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
const WindowsOutput = Schema.Struct({ windows: Schema.Array(WindowRecord) });
const PermissionOutput = Schema.Struct({
  accessibility: Schema.Boolean,
  screen_recording: Schema.Boolean,
  screen_recording_capturable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const WindowOutput = Schema.Struct({
  pid: Schema.Int,
  window_id: Schema.Int,
  snapshot_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  capture_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tree_markdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  degraded: Schema.optionalKey(Schema.Boolean),
  degraded_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  escalation: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        recommended: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  screenshot_width: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  screenshot_height: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  screenshot_frame_valid: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const ActionOutput = Schema.Struct({
  effect: Schema.Literals(["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]),
  route: Schema.String,
  delivery: Schema.optionalKey(Schema.NullOr(Schema.Struct({ mode: Schema.String }))),
  error: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        hint: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  hint: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const LaunchOutput = Schema.Struct({
  pid: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bundle_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const encodeObject = Schema.encodeEffect(Schema.fromJsonString(JsonObject));
const decodeObject = Schema.decodeEffect(Schema.fromJsonString(JsonObject));
const isComputerUseError = Schema.is(ComputerUseError);

export class CuaComputerDriver extends Context.Service<
  CuaComputerDriver,
  {
    readonly status: () => Effect.Effect<ComputerDriverStatus, ComputerUseError>;
    readonly setup: () => Effect.Effect<ComputerDriverStatus, ComputerUseError>;
    readonly listApps: () => Effect.Effect<ReadonlyArray<ComputerApp>, ComputerUseError>;
    readonly open: (appId: string) => Effect.Effect<ComputerApp, ComputerUseError>;
    readonly snapshot: (appId: string) => Effect.Effect<
      {
        readonly tree: string;
        readonly captureId?: string;
        readonly windowId?: string;
        readonly truncated?: boolean;
        readonly omittedLines?: number;
      },
      ComputerUseError
    >;
    readonly act: (
      appId: string,
      action: ComputerAction,
    ) => Effect.Effect<{ readonly message?: string }, ComputerUseError>;
    readonly screenshot: (appId: string) => Effect.Effect<
      {
        readonly path: string;
        readonly mimeType: "image/png" | "image/jpeg";
        readonly captureId?: string;
        readonly width?: number;
        readonly height?: number;
      },
      ComputerUseError
    >;
  }
>()("t3/computer/CuaComputerDriver") {}

type Target = { readonly pid: number; readonly windowId: number };
type Observation = Target & {
  readonly snapshotId?: string;
  readonly refs: ReadonlySet<string>;
  readonly captureId?: string;
  readonly width?: number;
  readonly height?: number;
};

function appIdentifier(app: typeof AppRecord.Type): string {
  return app.bundle_id || `pid:${app.pid}`;
}

function safeCode(code: string): string {
  return /^[a-zA-Z0-9_-]{1,96}$/.test(code) ? code : "driver_failure";
}

function degradationMessage(state: typeof WindowOutput.Type): string {
  const code =
    /^([a-z][a-z0-9_]{0,63})(?=:|$)/.exec(state.degraded_reason?.trim() ?? "")?.[1] ?? "unknown";
  const recovery =
    code === "screen_locked"
      ? "Wake and unlock the Mac, then inspect again."
      : state.escalation?.recommended === "foreground" ||
          code === "ax_window_unresolved" ||
          code === "ax_app_launching"
        ? 'Inspect again, or use delivery:"foreground" for type or press.'
        : "Inspect again after the app settles, or request a screenshot.";
  return `[accessibility degraded: ${code}]\n[recovery: ${recovery}]`;
}

function failureReason(value: string): ComputerUseError["reason"] {
  if (/permission|accessibility_not|screen_recording|not_authorized/i.test(value)) {
    return "permission_required";
  }
  if (
    /stale|expired|snapshot|capture_id|element_token|window_owner_pid_mismatch|window_id_not_found/i.test(
      value,
    )
  ) {
    return "stale_observation";
  }
  if (/unsupported|unavailable|background.*refus|route_unavailable/i.test(value)) {
    return "unavailable";
  }
  return "driver_failure";
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const installDirectory = path.join(serverConfig.stateDir, "computer", "cua-driver", VERSION);
  const binary = path.join(installDirectory, "cua-driver");
  const observations = new Map<string, Observation>();
  let generation = 0;
  let imageSequence = 0;
  let runtime:
    | {
        readonly scope: Scope.Closeable;
        readonly fiber: Fiber.Fiber<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
        readonly directory: string;
        readonly socket: string;
        readonly session: string;
        readonly env: NodeJS.ProcessEnv;
      }
    | undefined;

  // The user explicitly enables access at the host boundary. Driver prompts,
  // overlay windows, telemetry and network listeners are not part of this host.
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DO_NOT_TRACK: "1",
    CUA_TELEMETRY: "0",
    CUA_DRIVER_TELEMETRY: "0",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
    CUA_DRIVER_RS_PERMISSIONS_GATE: "0",
  };

  const stop = Effect.gen(function* () {
    const previous = runtime;
    runtime = undefined;
    observations.clear();
    if (previous) yield* Scope.close(previous.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => stop);

  const run = Effect.fnUntraced(function* (input: ProcessRunner.ProcessRunInput) {
    return yield* runner
      .run({
        timeout: "15 seconds",
        maxOutputBytes: 1024 * 1024,
        outputMode: "error",
        env: baseEnv,
        extendEnv: false,
        ...input,
      })
      .pipe(
        Effect.tapError(() => stop),
        Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
      );
  });

  const requireSuccess = Effect.fnUntraced(function* (input: ProcessRunner.ProcessRunInput) {
    const result = yield* run(input);
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stdoutInvalidUtf8
    ) {
      return yield* new ComputerUseError({
        reason: failureReason(result.stdout + result.stderr),
        cause: result,
      });
    }
    return result.stdout;
  });

  const installed = Effect.gen(function* () {
    if (platform !== "darwin" || !path.isAbsolute(installDirectory)) return false;
    if (!(yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false)))) return false;
    return yield* run({ command: binary, args: ["--version"], maxOutputBytes: 4096 }).pipe(
      Effect.map((result) => result.code === 0 && result.stdout.trim() === `cua-driver ${VERSION}`),
      Effect.orElseSucceed(() => false),
    );
  });

  const ensureRuntime = Effect.gen(function* () {
    if (runtime && (yield* Effect.sync(() => runtime?.fiber.pollUnsafe())) === undefined)
      return runtime;
    yield* stop;
    if (!(yield* installed)) return yield* new ComputerUseError({ reason: "unavailable" });

    const runtimeScope = yield* Scope.fork(serviceScope);
    return yield* Effect.gen(function* () {
      const directory = yield* fs
        .makeTempDirectoryScoped({ directory: "/tmp", prefix: "sshcode-cua-" })
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
        );
      yield* fs
        .chmod(directory, 0o700)
        .pipe(
          Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
        );
      const socket = path.join(directory, "driver.sock");
      const env = { ...baseEnv, CUA_DRIVER_HOME: directory, CUA_HOME: directory };
      const fiber = yield* runner
        .run({
          command: binary,
          args: [
            "serve",
            "--socket",
            socket,
            "--pid-file",
            path.join(directory, "driver.pid"),
            "--embedded",
            "--no-permissions-gate",
            "--no-overlay",
            "--permission-mode",
            "unrestricted",
            "--dangerously-bypass-approvals",
          ],
          env,
          extendEnv: false,
          timeout: "1 hour",
          maxOutputBytes: 16 * 1024,
          outputMode: "truncate",
        })
        .pipe(Effect.forkIn(runtimeScope, { startImmediately: true, uninterruptible: false }));
      runtime = {
        scope: runtimeScope,
        fiber,
        directory,
        socket,
        session: `sshcode-${++generation}-${path.basename(directory)}`,
        env,
      };
      // A private daemon may need a moment to bind. Retry only the read-only
      // status probe; never retry input or launch commands after delivery.
      yield* requireSuccess({
        command: binary,
        args: ["status", "--socket", socket, "--pid-file", path.join(directory, "driver.pid")],
        env,
        timeout: "1 second",
        maxOutputBytes: 4096,
      }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 20 }));
      return runtime;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Scope.close(runtimeScope, exit).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (runtime?.scope === runtimeScope) runtime = undefined;
                  observations.clear();
                }),
              ),
            )
          : Effect.void,
      ),
    );
  });

  const call = Effect.fnUntraced(function* (
    tool: string,
    args: Record<string, unknown>,
    withSession = true,
  ) {
    const current = yield* ensureRuntime;
    const encoded = yield* encodeObject({
      ...args,
      ...(withSession ? { session: current.session } : {}),
    }).pipe(Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })));
    const stdout = yield* requireSuccess({
      command: binary,
      args: ["call", tool, encoded, "--socket", current.socket],
      env: current.env,
    });
    return yield* decodeObject(stdout).pipe(
      Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
    );
  });

  const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
    );

  const apps = Effect.gen(function* () {
    const result = yield* decode(AppsOutput, yield* call("list_apps", {}, false));
    return result.apps;
  });

  const targetFor = Effect.fnUntraced(function* (appId: string, mode: "inspect" | "act") {
    const app = (yield* apps).find(
      (candidate) => appIdentifier(candidate) === appId && candidate.running,
    );
    if (!app || app.pid <= 0) return yield* new ComputerUseError({ reason: "unavailable" });
    const result = yield* decode(
      WindowsOutput,
      yield* call("list_windows", { pid: app.pid, on_screen_only: false }, false),
    );
    const windows = result.windows.filter(
      (window) => window.pid === app.pid && window.window_id > 0,
    );
    const previous = observations.get(appId);
    // Fresh inspection follows the app's selected/frontmost window. Input
    // stays on the last inspected window even if another window appears.
    const selected =
      mode === "inspect"
        ? windows.toSorted(
            (a, b) =>
              Number(b.is_on_screen) - Number(a.is_on_screen) ||
              (b.z_index ?? -1) - (a.z_index ?? -1),
          )[0]
        : windows.find(
            (window) => previous?.pid === app.pid && window.window_id === previous.windowId,
          );
    if (!selected)
      return yield* new ComputerUseError({
        reason: mode === "inspect" ? "unavailable" : "stale_observation",
      });
    if (
      mode === "inspect" &&
      previous &&
      (previous.pid !== app.pid || previous.windowId !== selected.window_id)
    ) {
      observations.delete(appId);
    }
    return { pid: app.pid, windowId: selected.window_id };
  });

  const status = Effect.gen(function* (): Effect.fn.Return<ComputerDriverStatus, ComputerUseError> {
    const present = yield* installed;
    const empty: ComputerDriverStatus = {
      platform,
      installed: present,
      accessibility: "unknown",
      screenRecording: "unknown",
      reason:
        platform !== "darwin"
          ? "Native computer control requires macOS."
          : present
            ? null
            : `Cua Driver ${VERSION} is not installed. Run computer setup.`,
    };
    if (!present) return empty;
    return yield* Effect.gen(function* () {
      const permissions = yield* decode(
        PermissionOutput,
        yield* call("check_permissions", { prompt: false, probe_direct_capture: false }),
      );
      // macOS can cache a negative preflight inside a process. Recreate the
      // helper after the user grants access so status can observe the change.
      if (!permissions.accessibility || !permissions.screen_recording) yield* stop;
      return {
        ...empty,
        accessibility: permissions.accessibility ? ("granted" as const) : ("denied" as const),
        screenRecording: permissions.screen_recording ? ("granted" as const) : ("denied" as const),
        reason:
          !permissions.accessibility || !permissions.screen_recording
            ? "Allow Accessibility and Screen Recording for the SSHCode host in macOS System Settings."
            : permissions.screen_recording_capturable === false
              ? "macOS reports Screen Recording granted, but capture is unavailable."
              : null,
      };
    }).pipe(
      Effect.orElseSucceed(() => ({
        ...empty,
        reason: "The native driver could not report OS permissions.",
      })),
    );
  });

  const setup = Effect.gen(function* () {
    if (platform !== "darwin") return yield* status;
    if (!path.isAbsolute(installDirectory))
      return yield* new ComputerUseError({ reason: "unavailable" });
    if (!(yield* installed)) {
      yield* stop;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({ prefix: "sshcode-cua-install-" });
          const archive = path.join(staging, ARCHIVE);
          yield* requireSuccess({
            command: "/usr/bin/curl",
            args: [
              "--fail",
              "--location",
              "--silent",
              "--show-error",
              "--proto",
              "=https",
              "--max-time",
              "120",
              "--output",
              archive,
              ARCHIVE_URL,
            ],
            timeout: "125 seconds",
            maxOutputBytes: 4096,
          });
          const checksum = yield* requireSuccess({
            command: "/usr/bin/shasum",
            args: ["-a", "256", archive],
            timeout: "20 seconds",
            maxOutputBytes: 4096,
          });
          if (checksum.split(/\s+/)[0] !== ARCHIVE_SHA256)
            return yield* new ComputerUseError({ reason: "driver_failure" });
          yield* requireSuccess({
            command: "/usr/bin/tar",
            args: ["-xzf", archive, "-C", staging, "cua-driver"],
            timeout: "30 seconds",
            maxOutputBytes: 4096,
          });
          yield* fs.makeDirectory(installDirectory, { recursive: true });
          const stagedBinary = path.join(installDirectory, ".cua-driver-staging");
          yield* fs.copyFile(path.join(staging, "cua-driver"), stagedBinary);
          yield* fs.chmod(stagedBinary, 0o755);
          yield* fs.writeFileString(path.join(installDirectory, "LICENSE.txt"), MIT_LICENSE);
          yield* fs.rename(stagedBinary, binary);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isComputerUseError(cause)
            ? cause
            : new ComputerUseError({ reason: "driver_failure", cause }),
        ),
      );
      if (!(yield* installed)) return yield* new ComputerUseError({ reason: "driver_failure" });
    }
    return yield* status;
  });

  const listApps = Effect.gen(function* () {
    return (yield* apps)
      .filter((app) => !!app.bundle_id || (app.running && app.pid > 0))
      .toSorted(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          Number(b.running) - Number(a.running) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_APPS)
      .map((app): ComputerApp => ({
        id: appIdentifier(app).slice(0, 512),
        name: app.name.slice(0, 2048),
        ...(app.running && app.pid > 0 ? { pid: app.pid } : {}),
      }));
  });

  const open = Effect.fnUntraced(function* (appId: string) {
    if (appId.startsWith("pid:")) {
      const app = (yield* apps).find(
        (candidate) => appIdentifier(candidate) === appId && candidate.running,
      );
      if (!app) return yield* new ComputerUseError({ reason: "unavailable" });
      observations.delete(appId);
      return { id: appId, name: app.name.slice(0, 2048), pid: app.pid };
    }
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(appId) || appId.length > 512) {
      return yield* new ComputerUseError({ reason: "unavailable" });
    }
    const launched = yield* decode(LaunchOutput, yield* call("launch_app", { bundle_id: appId }));
    observations.delete(appId);
    return {
      id: appId,
      name: (launched.name ?? appId).slice(0, 2048),
      ...(launched.pid && launched.pid > 0 ? { pid: launched.pid } : {}),
    };
  });

  const snapshot = Effect.fnUntraced(function* (appId: string) {
    const target = yield* targetFor(appId, "inspect");
    const state = yield* decode(
      WindowOutput,
      yield* call("get_window_state", {
        pid: target.pid,
        window_id: target.windowId,
        include_screenshot: false,
        include_accessibility_tree: true,
        tree_format: "markdown",
        max_elements: 250,
        max_depth: 25,
        timeout_ms: 1500,
      }),
    );
    if (state.pid !== target.pid || state.window_id !== target.windowId)
      return yield* new ComputerUseError({ reason: "stale_observation" });
    const snapshotId = state.snapshot_id ?? undefined;
    if (
      (snapshotId !== undefined && !/^s[0-9a-f]{8}$/.test(snapshotId)) ||
      (!snapshotId && !state.degraded)
    )
      return yield* new ComputerUseError({ reason: "driver_failure" });
    const previous = observations.get(appId);
    const capture =
      previous?.pid === target.pid && previous.windowId === target.windowId && previous.captureId
        ? {
            captureId: previous.captureId,
            ...(previous.width === undefined ? {} : { width: previous.width }),
            ...(previous.height === undefined ? {} : { height: previous.height }),
          }
        : undefined;
    // An unresolved AX surface has no native snapshot ID. Preserve its exact
    // window for explicit foreground recovery without publishing invented refs.
    if (!snapshotId) {
      observations.set(appId, { ...target, refs: new Set(), ...capture });
      while (observations.size > MAX_APPS) observations.delete(observations.keys().next().value!);
      return {
        tree: `window ${target.windowId}; no accessibility refs\n${degradationMessage(state)}`,
        windowId: String(target.windowId),
        truncated: state.truncated === true,
        omittedLines: 0,
        ...(capture ? { captureId: capture.captureId } : {}),
      };
    }
    const current = yield* ensureRuntime;
    // Native snapshot counters restart at 1 in each daemon. Namespace only
    // the public ref prefix so a cancelled generation can never authorize a
    // later element with the same native token; dispatch preserves its suffix.
    const refPrefix = `${current.session}/${snapshotId}`;
    const header = `snapshot ${snapshotId}; refs are ${refPrefix}:N for [N]`;
    const degradation = state.degraded ? `\n${degradationMessage(state)}` : "";
    const truncationHint = "\n[tree truncated]";
    const maxBodyChars =
      MAX_TREE_CHARS - header.length - 1 - degradation.length - truncationHint.length;
    // Whole-line trimming keeps every advertised token intact. Root performs
    // observation patching; request full compact trees so no native diff is lost.
    const lines = (state.tree_markdown ?? "").split("\n");
    const kept: string[] = [];
    const refs = new Set<string>();
    let length = 0;
    for (const line of lines) {
      if (length + line.length + 1 > maxBodyChars) break;
      kept.push(line);
      length += line.length + 1;
      const match = /^\s*- \[(\d+)\]/.exec(line);
      if (match) refs.add(`${refPrefix}:${match[1]}`);
    }
    // Tree-only native reads retain the last screenshot frame. Keep its
    // unconsumed capture; the native click still validates the current frame.
    observations.set(appId, { ...target, snapshotId, refs, ...capture });
    while (observations.size > MAX_APPS) observations.delete(observations.keys().next().value!);
    const suffix = state.truncated || kept.length < lines.length ? truncationHint : "";
    return {
      tree: `${header}\n${kept.join("\n")}${suffix}${degradation}`,
      windowId: String(target.windowId),
      truncated: state.truncated === true || kept.length < lines.length,
      omittedLines: lines.length - kept.length,
      ...(capture ? { captureId: capture.captureId } : {}),
    };
  });

  const act = Effect.fnUntraced(function* (appId: string, action: ComputerAction) {
    const target = yield* targetFor(appId, "act");
    const observed = observations.get(appId);
    if (!observed || observed.pid !== target.pid || observed.windowId !== target.windowId)
      return yield* new ComputerUseError({ reason: "stale_observation" });
    let tool: string;
    const args: Record<string, unknown> = {
      target: { kind: "window", pid: target.pid, window_id: target.windowId },
      delivery_mode: action.delivery ?? "background",
    };
    switch (action.kind) {
      case "click":
        if (!observed.refs.has(action.ref))
          return yield* new ComputerUseError({ reason: "stale_observation" });
        tool = "click";
        Object.assign(args, {
          element_token: action.ref.slice(action.ref.lastIndexOf("/") + 1),
          button: action.button ?? "left",
          count: action.count ?? 1,
        });
        break;
      case "clickAt":
        if (
          !observed.captureId ||
          action.captureId !== observed.captureId ||
          !Number.isFinite(action.x) ||
          !Number.isFinite(action.y) ||
          action.x < 0 ||
          action.y < 0 ||
          observed.width === undefined ||
          observed.height === undefined ||
          action.x >= observed.width ||
          action.y >= observed.height
        )
          return yield* new ComputerUseError({ reason: "stale_observation" });
        tool = "click";
        Object.assign(args, {
          capture_id: action.captureId,
          x: action.x,
          y: action.y,
          button: action.button ?? "left",
          count: action.count ?? 1,
        });
        break;
      case "type":
        if (action.text.length > 20_000)
          return yield* new ComputerUseError({ reason: "driver_failure" });
        tool = "type_text";
        args.text = action.text;
        break;
      case "press":
        tool = "press_key";
        Object.assign(args, { key: action.key, modifiers: action.modifiers ?? [] });
        break;
      case "scroll":
        // The macOS CLI supports coordinate-free scrolling of the focused
        // scroller in this exact window. Portable ScrollInput requires x/y
        // only on the native implementation's desktop-scope branch.
        tool = "scroll";
        Object.assign(args, {
          direction: action.direction,
          amount: Math.ceil(Math.min(10, Math.max(1, action.amount ?? 3))),
          by: "line",
        });
        break;
    }
    // Input can invalidate pixel grounding even when its effect cannot be
    // verified. Consume locally before dispatch, just as the native registry does.
    observations.set(appId, {
      ...target,
      refs: observed.refs,
      ...(observed.snapshotId ? { snapshotId: observed.snapshotId } : {}),
    });
    const result = yield* decode(ActionOutput, yield* call(tool, args));
    if (result.effect === "refused")
      return yield* new ComputerUseError({
        reason: failureReason(result.error?.code ?? result.hint ?? "refused"),
        cause: result,
      });
    return {
      message: `${result.effect} via ${safeCode(result.route)} (${safeCode(result.delivery?.mode ?? "unknown")} delivery)${result.hint ? `: ${result.hint.slice(0, 512)}` : ""}`,
    };
  });

  const screenshot = Effect.fnUntraced(function* (appId: string) {
    const target = yield* targetFor(appId, "inspect");
    const current = yield* ensureRuntime;
    const imagePath = path.join(current.directory, `screenshot-${imageSequence++ % 8}.png`);
    yield* fs.remove(imagePath, { force: true }).pipe(Effect.ignore);
    const state = yield* decode(
      WindowOutput,
      yield* call("get_window_state", {
        pid: target.pid,
        window_id: target.windowId,
        include_accessibility_tree: false,
        include_screenshot: true,
        screenshot_out_file: imagePath,
        max_image_dimension: 1600,
      }),
    );
    if (
      state.pid !== target.pid ||
      state.window_id !== target.windowId ||
      state.screenshot_frame_valid === false
    )
      return yield* new ComputerUseError({ reason: "stale_observation" });
    const info = yield* fs
      .stat(imagePath)
      .pipe(
        Effect.mapError((cause) => new ComputerUseError({ reason: "permission_required", cause })),
      );
    if (info.type !== "File" || info.size <= 0 || info.size > MAX_IMAGE_BYTES)
      return yield* new ComputerUseError({ reason: "driver_failure" });
    const previous = observations.get(appId);
    observations.set(appId, {
      ...target,
      refs:
        previous?.pid === target.pid &&
        previous.windowId === target.windowId &&
        previous.snapshotId === state.snapshot_id
          ? previous.refs
          : new Set(),
      ...(state.snapshot_id ? { snapshotId: state.snapshot_id } : {}),
      ...(state.capture_id ? { captureId: state.capture_id } : {}),
      ...(state.screenshot_width ? { width: state.screenshot_width } : {}),
      ...(state.screenshot_height ? { height: state.screenshot_height } : {}),
    });
    while (observations.size > MAX_APPS) observations.delete(observations.keys().next().value!);
    return {
      path: imagePath,
      mimeType: "image/png" as const,
      ...(state.capture_id ? { captureId: state.capture_id } : {}),
      ...(state.screenshot_width ? { width: state.screenshot_width } : {}),
      ...(state.screenshot_height ? { height: state.screenshot_height } : {}),
    };
  });

  // Interruption closes the native daemon as well as the caller CLI. Killing
  // only a one-shot CLI would leave an already-dispatched native action alive.
  const serialized = <A>(effect: Effect.Effect<A, ComputerUseError>) =>
    lock.withPermit(effect.pipe(Effect.onInterrupt(() => stop)));

  // Capture the layer's scope for lazily-created native resources, rather than
  // leaking a Scope requirement into callers of this service.
  return CuaComputerDriver.of({
    status: () => serialized(status),
    setup: () => serialized(setup),
    listApps: () => serialized(listApps),
    open: (appId) => serialized(open(appId)),
    snapshot: (appId) => serialized(snapshot(appId)),
    act: (appId, action) => serialized(act(appId, action)),
    screenshot: (appId) => serialized(screenshot(appId)),
  });
});

export const layer = Layer.effect(CuaComputerDriver, make);
