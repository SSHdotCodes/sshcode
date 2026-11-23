import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CuaComputerDriver from "./CuaComputerDriver.ts";
import macosScrollInputSchema from "./fixtures/cua-driver-0.38.0-macos-scroll.schema.json" with { type: "json" };
import macosWindowStateInputSchema from "./fixtures/cua-driver-0.38.0-macos-window-state.schema.json" with { type: "json" };

const isNativeMacosScrollInput = Schema.is(
  SchemaRepresentation.fromJsonSchemaDocument(
    {
      dialect: "draft-2020-12",
      schema: macosScrollInputSchema,
      definitions: {},
    },
    { patterns: "apply" },
  ),
);

const isNativeMacosWindowStateInputShape = Schema.is(
  SchemaRepresentation.fromJsonSchemaDocument(
    {
      dialect: "draft-2020-12",
      schema: macosWindowStateInputSchema,
      definitions: {},
    },
    { patterns: "apply" },
  ),
);

// The JSON-schema import permits extra keys; the native dispatcher rejects them.
const isNativeMacosWindowStateInput = (input: Record<string, unknown>) =>
  Object.keys(input).every((key) => Object.hasOwn(macosWindowStateInputSchema.properties, key)) &&
  isNativeMacosWindowStateInputShape(input);

const APP = "com.example.Editor";
const CHECKSUM = "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

function elementRef(tree: string, index: number): string {
  const prefix = /refs are (\S+):N/.exec(tree)?.[1];
  expect(prefix).toBeDefined();
  return `${prefix}:${index}`;
}

function output(stdout: unknown, code = 0): ProcessRunner.ProcessRunOutput {
  return {
    code: ChildProcessSpawner.ExitCode(code),
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

const withDriver = <A, E, R>(
  test: (fixture: {
    readonly driver: CuaComputerDriver.CuaComputerDriver["Service"];
    readonly calls: ProcessRunner.ProcessRunInput[];
    readonly appCalls: Array<{ tool: string; args: Record<string, unknown> }>;
    readonly state: {
      pidOnly: boolean;
      secondWindow: boolean;
      frontWindowId: number;
      treeState: Record<string, unknown> | undefined;
      tree: string;
      snapshot: number;
      windowId: number;
      pid: number;
      nativeTruncated: boolean;
      invalidChecksum: boolean;
      accessibility: boolean;
      screenRecording: boolean;
      stopped: number;
      imageBytes: Uint8Array;
      action: {
        effect: string;
        route: string;
        delivery: { mode: string };
        hint?: string;
        error?: { code: string };
      };
      actionOverride:
        | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
        | undefined;
      readinessOverride:
        | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
        | undefined;
      malformedTree?: boolean;
    };
  }) => Effect.Effect<A, E, R>,
  options: { installed?: boolean; platform?: NodeJS.Platform } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const installDirectory = path.join(config.stateDir, "computer", "cua-driver", "0.38.0");
    if (options.installed !== false) {
      yield* fs.makeDirectory(installDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(installDirectory, "cua-driver"),
        "fake executable, never run",
      );
    }
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const appCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const state = {
      pidOnly: false,
      secondWindow: false,
      frontWindowId: 21,
      treeState: undefined as Record<string, unknown> | undefined,
      tree: '- [0] AXButton "Save"\n- [1] AXTextField = "draft"',
      snapshot: 0,
      windowId: 21,
      pid: 42,
      nativeTruncated: false,
      invalidChecksum: false,
      accessibility: true,
      screenRecording: true,
      stopped: 0,
      imageBytes: PNG as Uint8Array,
      action: { effect: "confirmed", route: "accessibility", delivery: { mode: "background" } },
      actionOverride: undefined as
        | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
        | undefined,
      readinessOverride: undefined as
        | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
        | undefined,
      malformedTree: false,
    };
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (input.args[0] === "serve") {
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  state.stopped++;
                }),
              ),
            );
          }
          if (input.args[0] === "--version") return output("cua-driver 0.38.0\n");
          if (input.args[0] === "status")
            return state.readinessOverride
              ? yield* state.readinessOverride
              : output("Cua Driver daemon is running\n");
          if (input.command === "/usr/bin/curl") {
            const archive = input.args[input.args.indexOf("--output") + 1]!;
            yield* fs.writeFileString(archive, "pinned test archive").pipe(Effect.orDie);
            return output("");
          }
          if (input.command === "/usr/bin/shasum")
            return output(`${state.invalidChecksum ? "0".repeat(64) : CHECKSUM}  archive.tar.gz\n`);
          if (input.command === "/usr/bin/tar") {
            const staging = input.args[input.args.indexOf("-C") + 1]!;
            yield* fs
              .writeFileString(path.join(staging, "cua-driver"), "pinned CLI")
              .pipe(Effect.orDie);
            return output("");
          }
          expect(input.args[0]).toBe("call");
          const tool = input.args[1]!;
          const args = JSON.parse(input.args[2]!) as Record<string, unknown>;
          appCalls.push({ tool, args });
          switch (tool) {
            case "list_apps":
              return output({
                apps: [
                  {
                    name: "Editor",
                    bundle_id: state.pidOnly ? null : APP,
                    pid: state.pid,
                    running: true,
                    active: true,
                  },
                  {
                    name: "Calculator",
                    bundle_id: "com.apple.calculator",
                    pid: 0,
                    running: false,
                    active: false,
                  },
                ],
              });
            case "list_windows":
              return output({
                windows: [
                  {
                    pid: state.pid,
                    window_id: state.windowId,
                    title: "draft",
                    is_on_screen: true,
                    z_index: state.frontWindowId === state.windowId ? 3 : 2,
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                  },
                  ...(state.secondWindow
                    ? [
                        {
                          pid: state.pid,
                          window_id: 22,
                          title: "new document",
                          is_on_screen: true,
                          z_index: state.frontWindowId === 22 ? 3 : 2,
                          bounds: { x: 0, y: 0, width: 800, height: 600 },
                        },
                      ]
                    : []),
                ],
              });
            case "check_permissions":
              return output({
                accessibility: state.accessibility,
                screen_recording: state.screenRecording,
                screen_recording_capturable: null,
              });
            case "launch_app":
              return output({ pid: state.pid, name: "Editor", bundle_id: APP });
            case "get_window_state": {
              expect(isNativeMacosWindowStateInput(args)).toBe(true);
              if (state.malformedTree) return output("{broken");
              if (typeof args.screenshot_out_file === "string") {
                yield* fs.writeFile(args.screenshot_out_file, state.imageBytes).pipe(Effect.orDie);
                return output({
                  pid: state.pid,
                  window_id: args.window_id,
                  snapshot_id: `s${state.snapshot.toString(16).padStart(8, "0")}`,
                  capture_id: `capture-${appCalls.length}`,
                  screenshot_width: 800,
                  screenshot_height: 600,
                  screenshot_frame_valid: true,
                });
              }
              if (state.treeState)
                return output({ pid: state.pid, window_id: args.window_id, ...state.treeState });
              return output({
                pid: state.pid,
                window_id: args.window_id,
                snapshot_id: `s${(++state.snapshot).toString(16).padStart(8, "0")}`,
                tree_markdown: state.tree,
                truncated: state.nativeTruncated,
              });
            }
            default:
              return state.actionOverride ? yield* state.actionOverride : output(state.action);
          }
        }),
    });
    return yield* Effect.gen(function* () {
      const driver = yield* CuaComputerDriver.CuaComputerDriver;
      return yield* test({ driver, calls, appCalls, state });
    }).pipe(
      Effect.provide(
        CuaComputerDriver.layer.pipe(
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        ),
      ),
      Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
      Effect.provideService(HostProcess.HomeDirectory, config.stateDir),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest("/tmp", { prefix: "cua-driver-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

describe("CuaComputerDriver", () => {
  it.effect("clears PID-only refs and captures whenever a new open starts a lease", () =>
    withDriver(({ driver, state, appCalls }) =>
      Effect.gen(function* () {
        state.pidOnly = true;
        const appId = "pid:42";
        yield* driver.open(appId);
        const snapshot = yield* driver.snapshot(appId);
        const capture = yield* driver.screenshot(appId);
        const ref = elementRef(snapshot.tree, 0);
        // Release/idle stop is owned by the control service. The next lease
        // always enters the driver through open, even for a still-running PID.
        yield* driver.open(appId);
        expect((yield* driver.act(appId, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        expect(
          (yield* driver
            .act(appId, { kind: "clickAt", captureId: capture.captureId!, x: 10, y: 10 })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
        expect(appCalls.some((call) => call.tool === "click")).toBe(false);
        const replacement = yield* driver.snapshot(appId);
        expect(replacement).not.toHaveProperty("captureId");
        expect((yield* driver.act(appId, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        yield* driver.act(appId, { kind: "click", ref: elementRef(replacement.tree, 0) });
      }),
    ),
  );

  it.effect(
    "fresh snapshots follow selected app windows while input stays on the last inspected window",
    () =>
      withDriver(({ driver, state, appCalls }) =>
        Effect.gen(function* () {
          const first = yield* driver.snapshot(APP);
          const capture = yield* driver.screenshot(APP);
          const firstRef = elementRef(first.tree, 0);
          state.secondWindow = true;
          state.frontWindowId = 22;
          yield* driver.act(APP, { kind: "click", ref: firstRef });
          expect(appCalls.findLast((call) => call.tool === "click")?.args.target).toEqual({
            kind: "window",
            pid: 42,
            window_id: 21,
          });
          const second = yield* driver.snapshot(APP);
          expect(second.windowId).toBe("22");
          expect(
            appCalls.findLast((call) => call.tool === "get_window_state")?.args.window_id,
          ).toBe(22);
          expect(
            (yield* driver.act(APP, { kind: "click", ref: firstRef }).pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          expect(
            (yield* driver
              .act(APP, { kind: "clickAt", captureId: capture.captureId!, x: 10, y: 10 })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          yield* driver.act(APP, { kind: "click", ref: elementRef(second.tree, 0) });
          expect(appCalls.findLast((call) => call.tool === "click")?.args.target).toEqual({
            kind: "window",
            pid: 42,
            window_id: 22,
          });
          state.frontWindowId = 21;
          expect((yield* driver.snapshot(APP)).windowId).toBe("21");
        }),
      ),
  );

  it.effect(
    "fresh screenshots follow a newly selected window and invalidate its predecessor's refs and capture",
    () =>
      withDriver(({ driver, state, appCalls }) =>
        Effect.gen(function* () {
          const first = yield* driver.snapshot(APP);
          const previousCapture = yield* driver.screenshot(APP);
          state.secondWindow = true;
          state.frontWindowId = 22;
          const selected = yield* driver.screenshot(APP);
          expect(
            appCalls.findLast((call) => call.tool === "get_window_state")?.args.window_id,
          ).toBe(22);
          expect(
            (yield* driver
              .act(APP, { kind: "click", ref: elementRef(first.tree, 0) })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          expect(
            (yield* driver
              .act(APP, { kind: "clickAt", captureId: previousCapture.captureId!, x: 10, y: 10 })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          yield* driver.act(APP, { kind: "clickAt", captureId: selected.captureId!, x: 10, y: 10 });
          expect(appCalls.findLast((call) => call.tool === "click")?.args.target).toEqual({
            kind: "window",
            pid: 42,
            window_id: 22,
          });
        }),
      ),
  );

  it.effect("drops unconsumed pixel grounding when a text inspection selects another window", () =>
    withDriver(({ driver, state, appCalls }) =>
      Effect.gen(function* () {
        yield* driver.snapshot(APP);
        const capture = yield* driver.screenshot(APP);
        state.secondWindow = true;
        state.frontWindowId = 22;
        expect((yield* driver.snapshot(APP)).captureId).toBeUndefined();
        expect(
          (yield* driver
            .act(APP, { kind: "clickAt", captureId: capture.captureId!, x: 10, y: 10 })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
        expect(appCalls.some((call) => call.tool === "click")).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps degraded native windows inspectable without inventing refs and permits explicit foreground recovery",
    () =>
      withDriver(({ driver, state, appCalls }) =>
        Effect.gen(function* () {
          const before = yield* driver.snapshot(APP);
          state.treeState = {
            tree_markdown: "",
            degraded: true,
            degraded_reason:
              "ax_window_unresolved: background input is unavailable, try foreground",
            escalation: {
              recommended: "foreground",
              reason: "Native background window is unresolved.",
            },
          };
          const degraded = yield* driver.snapshot(APP);
          expect(degraded.tree).toContain("no accessibility refs");
          expect(degraded.tree).toContain("accessibility degraded: ax_window_unresolved");
          expect(degraded.tree).toContain('delivery:"foreground"');
          expect(degraded.tree).not.toContain("driver_failure");
          expect(degraded.windowId).toBe("21");
          expect(
            (yield* driver
              .act(APP, { kind: "click", ref: elementRef(before.tree, 0) })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          yield* driver.act(APP, { kind: "press", key: "Escape", delivery: "foreground" });
          yield* driver.act(APP, { kind: "type", text: "recovered", delivery: "foreground" });
          for (const tool of ["press_key", "type_text"]) {
            expect(appCalls.findLast((call) => call.tool === tool)?.args).toMatchObject({
              target: { kind: "window", pid: 42, window_id: 21 },
              delivery_mode: "foreground",
            });
          }
          expect(appCalls.some((call) => call.args.include_screenshot === true)).toBe(false);
        }),
      ),
  );

  it.effect(
    "normalizes degraded reasons and keeps missing or malformed ordinary snapshot ids invalid",
    () =>
      withDriver(({ driver, state }) =>
        Effect.gen(function* () {
          state.treeState = { tree_markdown: "" };
          expect((yield* driver.snapshot(APP).pipe(Effect.flip)).reason).toBe("driver_failure");
          state.treeState = { tree_markdown: "", snapshot_id: "invalid" };
          expect((yield* driver.snapshot(APP).pipe(Effect.flip)).reason).toBe("driver_failure");
          state.treeState = { tree_markdown: "", degraded: true, snapshot_id: "not-a-native-id" };
          expect((yield* driver.snapshot(APP).pipe(Effect.flip)).reason).toBe("driver_failure");
          state.treeState = {
            tree_markdown: "",
            snapshot_id: "s00000001",
            degraded: true,
            degraded_reason: "ax_app_launching: lookup timed out; inspect again",
            escalation: { recommended: "foreground" },
          };
          expect((yield* driver.snapshot(APP)).tree).toContain(
            "accessibility degraded: ax_app_launching",
          );
          state.treeState = {
            snapshot_id: "s00000002",
            degraded: true,
            degraded_reason: `${"a".repeat(64)}: unreadable native surface`,
            tree_markdown: Array.from(
              { length: 250 },
              (_, index) => `- [${index}] AXTextField "${"x".repeat(300)}"`,
            ).join("\n"),
            escalation: { recommended: "foreground" },
          };
          expect((yield* driver.snapshot(APP)).tree.length).toBeLessThanOrEqual(24_000);
          state.treeState = {
            tree_markdown: "",
            degraded: true,
            degraded_reason: "screen_locked: no AX windows",
            escalation: { recommended: "foreground" },
          };
          const locked = yield* driver.snapshot(APP);
          expect(locked.tree).toContain("Wake and unlock");
          expect(locked.tree).not.toContain('delivery:"foreground"');
          state.treeState = {
            tree_markdown: "",
            degraded: true,
            degraded_reason: "!".repeat(100_000),
          };
          const unknown = yield* driver.snapshot(APP);
          expect(unknown.tree).toContain("accessibility degraded: unknown");
          expect(unknown.tree.length).toBeLessThan(512);
        }),
      ),
  );

  it.effect(
    "retains unconsumed screenshot grounding through same-window text reads and still uses native capture validation",
    () =>
      withDriver(({ driver, state, appCalls }) =>
        Effect.gen(function* () {
          const first = yield* driver.snapshot(APP);
          const image = yield* driver.screenshot(APP);
          const reread = yield* driver.snapshot(APP);
          expect(reread.captureId).toBe(image.captureId);
          expect(
            (yield* driver
              .act(APP, { kind: "click", ref: elementRef(first.tree, 0) })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          yield* driver.act(APP, { kind: "clickAt", captureId: image.captureId!, x: 10, y: 10 });
          expect(appCalls.findLast((call) => call.tool === "click")?.args.capture_id).toBe(
            image.captureId,
          );
          expect((yield* driver.snapshot(APP)).captureId).toBeUndefined();
          expect(
            (yield* driver
              .act(APP, { kind: "clickAt", captureId: image.captureId!, x: 10, y: 10 })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          const resized = yield* driver.screenshot(APP);
          yield* driver.snapshot(APP);
          state.actionOverride = Effect.succeed(output({ code: "capture_id_expired" }, 1));
          expect(
            (yield* driver
              .act(APP, { kind: "clickAt", captureId: resized.captureId!, x: 10, y: 10 })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          expect(appCalls.findLast((call) => call.tool === "click")?.args.capture_id).toBe(
            resized.captureId,
          );
        }),
      ),
  );

  it.effect("drops retained capture grounding after any input before another text read", () =>
    withDriver(({ driver }) =>
      Effect.gen(function* () {
        yield* driver.snapshot(APP);
        const image = yield* driver.screenshot(APP);
        yield* driver.act(APP, { kind: "press", key: "Escape" });
        expect((yield* driver.snapshot(APP)).captureId).toBeUndefined();
        expect(
          (yield* driver
            .act(APP, { kind: "clickAt", captureId: image.captureId!, x: 10, y: 10 })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
      }),
    ),
  );

  it.effect(
    "validates coordinate-free window scroll against the pinned native CLI input schema",
    () =>
      withDriver(({ driver, appCalls }) =>
        Effect.gen(function* () {
          yield* driver.snapshot(APP);
          yield* driver.act(APP, { kind: "scroll", direction: "down", amount: 2 });
          const scroll = appCalls.find((call) => call.tool === "scroll")!;
          expect(macosScrollInputSchema.required).toEqual(["direction"]);
          expect(isNativeMacosScrollInput(scroll.args)).toBe(true);
          expect(isNativeMacosScrollInput({ amount: 2, target: scroll.args.target })).toBe(false);
          expect(scroll.args.target).toEqual({ kind: "window", pid: 42, window_id: 21 });
          expect(scroll.args).not.toHaveProperty("x");
          expect(scroll.args).not.toHaveProperty("y");
          expect(appCalls.filter((call) => call.tool === "get_window_state")).toHaveLength(1);
          expect(
            appCalls.find((call) => call.tool === "get_window_state")?.args.include_screenshot,
          ).toBe(false);
        }),
      ),
  );
  it.effect("constructs lazily and reports unsupported hosts without spawning anything", () =>
    withDriver(
      ({ driver, calls }) =>
        Effect.gen(function* () {
          expect(calls).toHaveLength(0);
          expect(yield* driver.status()).toMatchObject({
            platform: "linux",
            installed: false,
            accessibility: "unknown",
          });
          expect(yield* driver.setup()).toMatchObject({ installed: false });
          expect((yield* driver.listApps().pipe(Effect.flip)).reason).toBe("unavailable");
          expect(calls).toHaveLength(0);
        }),
      { platform: "linux" },
    ),
  );

  it.effect("reports a missing pinned binary without launching or auto-installing it", () =>
    withDriver(
      ({ driver, calls }) =>
        Effect.gen(function* () {
          expect(yield* driver.status()).toMatchObject({
            installed: false,
            screenRecording: "unknown",
          });
          expect((yield* driver.listApps().pipe(Effect.flip)).reason).toBe("unavailable");
          expect(calls).toHaveLength(0);
        }),
      { installed: false },
    ),
  );

  it.effect("setup stages only the checksum-pinned CLI under the environment state directory", () =>
    withDriver(
      ({ driver, calls, appCalls, state }) =>
        Effect.gen(function* () {
          state.accessibility = false;
          state.screenRecording = false;
          expect(yield* driver.setup()).toMatchObject({
            installed: true,
            accessibility: "denied",
            screenRecording: "denied",
          });
          const download = calls.find((call) => call.command === "/usr/bin/curl")!;
          expect(download.args.at(-1)).toContain(
            "/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
          );
          expect(calls.find((call) => call.command === "/usr/bin/tar")?.args.at(-1)).toBe(
            "cua-driver",
          );
          expect(calls.find((call) => call.args[0] === "serve")?.command).toContain(
            "/userdata/computer/cua-driver/0.38.0/cua-driver",
          );
          expect(appCalls.find((call) => call.tool === "check_permissions")?.args).toMatchObject({
            prompt: false,
            probe_direct_capture: false,
          });
          for (const call of calls) {
            expect(call.command.startsWith("/")).toBe(true);
            expect(call.timeout).toBeDefined();
            expect(call.maxOutputBytes).toBeDefined();
            expect(call.extendEnv).toBe(false);
            expect(call.env?.DO_NOT_TRACK).toBe("1");
          }
        }),
      { installed: false },
    ),
  );

  it.effect("refuses an archive checksum mismatch before extraction or native startup", () =>
    withDriver(
      ({ driver, calls, state }) =>
        Effect.gen(function* () {
          state.invalidChecksum = true;
          expect((yield* driver.setup().pipe(Effect.flip)).reason).toBe("driver_failure");
          expect(
            calls.some((call) => call.command === "/usr/bin/tar" || call.args[0] === "serve"),
          ).toBe(false);
        }),
      { installed: false },
    ),
  );

  it.effect("lists installed and running apps and opens only a bundle id", () =>
    withDriver(({ driver, appCalls }) =>
      Effect.gen(function* () {
        expect(yield* driver.listApps()).toEqual([
          { id: APP, name: "Editor", pid: 42 },
          { id: "com.apple.calculator", name: "Calculator" },
        ]);
        expect(yield* driver.open(APP)).toEqual({ id: APP, name: "Editor", pid: 42 });
        expect(appCalls.find((call) => call.tool === "launch_app")?.args).toMatchObject({
          bundle_id: APP,
        });
        expect((yield* driver.open("/tmp/untrusted-executable").pipe(Effect.flip)).reason).toBe(
          "unavailable",
        );
        expect(appCalls.filter((call) => call.tool === "launch_app")).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps compact native refs in a private session and rejects replaced snapshots", () =>
    withDriver(({ driver, appCalls }) =>
      Effect.gen(function* () {
        const snapshot = yield* driver.snapshot(APP);
        expect(snapshot.tree).toMatch(/refs are sshcode-[^/]+\/s00000001:N/);
        expect(snapshot.tree).toContain('- [0] AXButton "Save"');
        expect(snapshot.truncated).toBe(false);
        expect(appCalls.find((call) => call.tool === "get_window_state")?.args).toMatchObject({
          include_screenshot: false,
          tree_format: "markdown",
          max_elements: 250,
          timeout_ms: 1500,
        });
        const ref = elementRef(snapshot.tree, 0);
        yield* driver.act(APP, { kind: "click", ref });
        const click = appCalls.find((call) => call.tool === "click")!;
        expect(click.args).toMatchObject({
          element_token: "s00000001:0",
          target: { kind: "window", pid: 42, window_id: 21 },
          delivery_mode: "background",
        });
        expect(click.args.session).toBe(
          appCalls.find((call) => call.tool === "get_window_state")?.args.session,
        );
        const reread = yield* driver.snapshot(APP);
        expect(reread.tree.split("\n").slice(1)).toEqual(snapshot.tree.split("\n").slice(1));
        expect(reread.tree.split("\n")[0]).not.toBe(snapshot.tree.split("\n")[0]);
        expect((yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        expect(appCalls.filter((call) => call.tool === "click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("bounds accessibility text at whole lines and exposes native/local clipping", () =>
    withDriver(({ driver, state }) =>
      Effect.gen(function* () {
        state.tree = Array.from(
          { length: 250 },
          (_, i) => `- [${i}] AXTextField "${"x".repeat(300)}"`,
        ).join("\n");
        state.nativeTruncated = true;
        const result = yield* driver.snapshot(APP);
        expect(result.tree.length).toBeLessThanOrEqual(24_000);
        expect(result.tree.endsWith("[tree truncated]")).toBe(true);
        expect(result.truncated).toBe(true);
        expect(result.omittedLines).toBeGreaterThan(0);
        expect(
          (yield* driver
            .act(APP, { kind: "click", ref: elementRef(result.tree, 249) })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
      }),
    ),
  );

  it.effect("returns private PNGs only on demand and consumes native coordinate capture ids", () =>
    withDriver(({ driver, appCalls }) =>
      Effect.gen(function* () {
        yield* driver.snapshot(APP);
        const screenshot = yield* driver.screenshot(APP);
        expect(screenshot.path).toMatch(/^\/tmp\/sshcode-cua-[^/]+\/screenshot-\d\.png$/);
        expect(screenshot).toMatchObject({ mimeType: "image/png", width: 800, height: 600 });
        expect(screenshot.captureId).toBeDefined();
        const request = appCalls.findLast((call) => call.tool === "get_window_state")!.args;
        expect(request).toMatchObject({
          include_accessibility_tree: false,
          include_screenshot: true,
          max_image_dimension: 1600,
        });
        expect(isNativeMacosWindowStateInput(request)).toBe(true);
        expect(isNativeMacosWindowStateInput({ ...request, screenshot_format: "png" })).toBe(false);
        expect(
          (yield* driver
            .act(APP, { kind: "clickAt", captureId: "old", x: 2, y: 2 })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
        yield* driver.act(APP, { kind: "clickAt", captureId: screenshot.captureId!, x: 2, y: 2 });
        expect(appCalls.findLast((call) => call.tool === "click")?.args.capture_id).toBe(
          screenshot.captureId,
        );
        expect(
          (yield* driver
            .act(APP, { kind: "clickAt", captureId: screenshot.captureId!, x: 2, y: 2 })
            .pipe(Effect.flip)).reason,
        ).toBe("stale_observation");
      }),
    ),
  );

  it.effect(
    "keeps shell-shaped text as one JSON argument and honors explicit foreground delivery",
    () =>
      withDriver(({ driver, appCalls }) =>
        Effect.gen(function* () {
          yield* driver.snapshot(APP);
          const text = "'; $(touch /tmp/not-a-command) `id`\nhello";
          yield* driver.act(APP, { kind: "type", text, delivery: "foreground" });
          yield* driver.act(APP, { kind: "press", key: "Return", modifiers: ["cmd"] });
          yield* driver.act(APP, { kind: "scroll", direction: "down", amount: 2 });
          expect(appCalls.find((call) => call.tool === "type_text")?.args).toMatchObject({
            text,
            delivery_mode: "foreground",
          });
          expect(appCalls.find((call) => call.tool === "press_key")?.args).toMatchObject({
            key: "Return",
            modifiers: ["cmd"],
          });
          expect(appCalls.find((call) => call.tool === "scroll")?.args).toMatchObject({
            direction: "down",
            amount: 2,
            by: "line",
          });
        }),
      ),
  );

  it.effect("reports refused background delivery and unverifiable effects truthfully", () =>
    withDriver(({ driver, state, appCalls }) =>
      Effect.gen(function* () {
        yield* driver.snapshot(APP);
        state.action = {
          effect: "refused",
          route: "synthetic_events",
          delivery: { mode: "background" },
        };
        Object.assign(state.action, { error: { code: "background_input_unavailable" } });
        expect(
          (yield* driver.act(APP, { kind: "type", text: "hello" }).pipe(Effect.flip)).reason,
        ).toBe("unavailable");
        expect(appCalls.filter((call) => call.tool === "type_text")).toHaveLength(1);
        state.action = {
          effect: "unverifiable",
          route: "synthetic_events",
          delivery: { mode: "background" },
        };
        expect((yield* driver.act(APP, { kind: "press", key: "Return" })).message).toContain(
          "unverifiable",
        );
      }),
    ),
  );

  it.effect(
    "refuses refs after the app process/window changes and malformed native observations",
    () =>
      withDriver(({ driver, state, appCalls }) =>
        Effect.gen(function* () {
          const snapshot = yield* driver.snapshot(APP);
          state.pid = 99;
          state.windowId = 100;
          expect(
            (yield* driver
              .act(APP, { kind: "click", ref: elementRef(snapshot.tree, 0) })
              .pipe(Effect.flip)).reason,
          ).toBe("stale_observation");
          expect(appCalls.some((call) => call.tool === "click")).toBe(false);
          state.malformedTree = true;
          expect((yield* driver.snapshot(APP).pipe(Effect.flip)).reason).toBe("driver_failure");
        }),
      ),
  );

  it.effect("interrupts native actions and awaits daemon cleanup before accepting new work", () =>
    withDriver(({ driver, state, appCalls }) =>
      Effect.gen(function* () {
        const snapshot = yield* driver.snapshot(APP);
        const ref = elementRef(snapshot.tree, 0);
        const started = yield* Deferred.make<void>();
        const cliStopped = yield* Deferred.make<void>();
        state.actionOverride = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cliStopped, undefined)),
        );
        const action = yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(action);
        yield* Deferred.await(cliStopped);
        expect(state.stopped).toBe(1);
        state.actionOverride = undefined;
        expect((yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        expect(appCalls.filter((call) => call.tool === "click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("cleans up a daemon interrupted during startup", () =>
    withDriver(({ driver, state }) =>
      Effect.gen(function* () {
        const starting = yield* Deferred.make<void>();
        state.readinessOverride = Deferred.succeed(starting, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const startingStatus = yield* driver.status().pipe(Effect.forkScoped);
        yield* Deferred.await(starting);
        yield* Fiber.interrupt(startingStatus);
        expect(state.stopped).toBe(1);
      }),
    ),
  );

  it.effect("recycles the native process after a timeout and rejects its old refs", () =>
    withDriver(({ driver, state }) =>
      Effect.gen(function* () {
        const snapshot = yield* driver.snapshot(APP);
        const ref = elementRef(snapshot.tree, 0);
        state.actionOverride = Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: "cua-driver",
            argumentCount: 5,
            timeoutMs: 15_000,
          }),
        );
        const error = yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.flip);
        expect(error.reason).toBe("driver_failure");
        expect(state.stopped).toBe(1);
        state.actionOverride = undefined;
        expect((yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        // Upstream counters restart at 1. A new native s00000001 must not
        // reauthorize the pre-timeout public reference.
        state.snapshot = 0;
        const replacement = yield* driver.snapshot(APP);
        const replacementRef = elementRef(replacement.tree, 0);
        expect(replacementRef.endsWith("/s00000001:0")).toBe(true);
        expect(replacementRef).not.toBe(ref);
        expect((yield* driver.act(APP, { kind: "click", ref }).pipe(Effect.flip)).reason).toBe(
          "stale_observation",
        );
        yield* driver.act(APP, { kind: "click", ref: replacementRef });
      }),
    ),
  );

  it.effect("rechecks previously denied OS permissions in a fresh native process", () =>
    withDriver(({ driver, state, calls }) =>
      Effect.gen(function* () {
        state.accessibility = false;
        expect((yield* driver.status()).accessibility).toBe("denied");
        expect(state.stopped).toBe(1);
        state.accessibility = true;
        expect((yield* driver.status()).accessibility).toBe("granted");
        expect(calls.filter((call) => call.args[0] === "serve")).toHaveLength(2);
      }),
    ),
  );
});
