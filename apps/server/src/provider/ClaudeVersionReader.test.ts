import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeVersionReader } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encoder = new TextEncoder();
// The start of an ELF file: what the reader needs to see to take it for a native executable.
const NATIVE_HEADER = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const isWindows = HostProcess.Platform.defaultValue() === "win32";
const EXECUTABLE_NAME = isWindows ? "claude.exe" : "claude";
// A modification time no freshly written test file has: 2026-01-01, in seconds.
const UPDATED_AT = 1_767_225_600;

/** Starts nothing: answers each `claude --version` with the next output and counts the runs. */
function versionSpawner(
  outputs: ReadonlyArray<{ readonly stdout: string; readonly code: number }>,
) {
  const runs = { count: 0 };
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => {
      const output = outputs[Math.min(runs.count, outputs.length - 1)] ?? { stdout: "", code: 1 };
      runs.count++;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(output.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  return { runs, layer };
}

const versionOutput = (
  probe: Result.Result<Option.Option<{ readonly stdout: string }>, unknown>,
): string | undefined =>
  Result.isSuccess(probe) && Option.isSome(probe.success)
    ? probe.success.value.stdout.trim()
    : undefined;

const writeExecutable = (filePath: string, contents: Uint8Array | string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* typeof contents === "string"
      ? fs.writeFileString(filePath, contents)
      : fs.writeFile(filePath, contents);
    yield* fs.chmod(filePath, 0o755);
  });

it.effect("reuses claude --version until its native executable changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-version-" });
    const executable = path.join(dir, EXECUTABLE_NAME);
    yield* writeExecutable(executable, NATIVE_HEADER);
    const { runs, layer } = versionSpawner([
      { stdout: "2.1.330 (Claude Code)\n", code: 0 },
      { stdout: "2.1.331 (Claude Code)\n", code: 0 },
      { stdout: "2.1.332 (Claude Code)\n", code: 0 },
    ]);
    const read = yield* makeClaudeVersionReader();
    const readVersion = read(decodeClaudeSettings({ binaryPath: executable }), {
      PATH: dir,
    }).pipe(Effect.provide(layer));

    assert.equal(versionOutput(yield* readVersion), "2.1.330 (Claude Code)");
    assert.equal(versionOutput(yield* readVersion), "2.1.330 (Claude Code)");
    assert.equal(runs.count, 1);

    // Rewritten in place: the same path with a new modification time.
    yield* fs.utimes(executable, UPDATED_AT, UPDATED_AT);
    assert.equal(versionOutput(yield* readVersion), "2.1.331 (Claude Code)");
    assert.equal(versionOutput(yield* readVersion), "2.1.331 (Claude Code)");
    assert.equal(runs.count, 2);

    // Replaced: a new file of another size renamed over it, its time set to match.
    const replacement = path.join(dir, `${EXECUTABLE_NAME}.new`);
    yield* writeExecutable(replacement, new Uint8Array([...NATIVE_HEADER, 0, 0, 0, 0]));
    yield* fs.utimes(replacement, UPDATED_AT, UPDATED_AT);
    yield* fs.rename(replacement, executable);
    assert.equal(versionOutput(yield* readVersion), "2.1.332 (Claude Code)");
    assert.equal(runs.count, 3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(isWindows)(
  "runs claude --version again when the command's link moves to another version",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-version-" });
      const bin = path.join(dir, "bin");
      yield* fs.makeDirectory(bin);
      for (const version of ["2.1.330", "2.1.331"]) {
        yield* writeExecutable(path.join(dir, version), NATIVE_HEADER);
        yield* fs.utimes(path.join(dir, version), UPDATED_AT, UPDATED_AT);
      }
      // How Claude Code's own installer updates: `claude` on PATH links to the version.
      const link = path.join(bin, "claude");
      yield* fs.symlink(path.join(dir, "2.1.330"), link);
      const { runs, layer } = versionSpawner([
        { stdout: "2.1.330 (Claude Code)\n", code: 0 },
        { stdout: "2.1.331 (Claude Code)\n", code: 0 },
      ]);
      const read = yield* makeClaudeVersionReader();
      const readVersion = read(decodeClaudeSettings({ binaryPath: "claude" }), {
        PATH: bin,
      }).pipe(Effect.provide(layer));

      yield* readVersion;
      yield* readVersion;
      assert.equal(runs.count, 1);
      yield* fs.remove(link);
      yield* fs.symlink(path.join(dir, "2.1.331"), link);
      assert.equal(versionOutput(yield* readVersion), "2.1.331 (Claude Code)");
      assert.equal(runs.count, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs claude --version every time for a script, which may start another Claude", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-version-" });
    const wrapper = path.join(dir, EXECUTABLE_NAME);
    yield* writeExecutable(wrapper, '#!/bin/sh\nexec "$HOME/.local/bin/claude" "$@"\n');
    const { runs, layer } = versionSpawner([{ stdout: "2.1.330 (Claude Code)\n", code: 0 }]);
    const read = yield* makeClaudeVersionReader();
    const readVersion = read(decodeClaudeSettings({ binaryPath: wrapper }), { PATH: dir }).pipe(
      Effect.provide(layer),
    );
    yield* readVersion;
    yield* readVersion;
    assert.equal(runs.count, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs claude --version every time when the executable cannot be found", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const emptyDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-version-" });
    const { runs, layer } = versionSpawner([{ stdout: "2.1.330 (Claude Code)\n", code: 0 }]);
    const read = yield* makeClaudeVersionReader();
    const readVersion = read(decodeClaudeSettings({ binaryPath: "claude" }), {
      PATH: emptyDir,
    }).pipe(Effect.provide(layer));
    assert.equal(versionOutput(yield* readVersion), "2.1.330 (Claude Code)");
    yield* readVersion;
    assert.equal(runs.count, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs claude --version again after a run that failed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-version-" });
    const executable = path.join(dir, EXECUTABLE_NAME);
    yield* writeExecutable(executable, NATIVE_HEADER);
    const { runs, layer } = versionSpawner([
      { stdout: "", code: 1 },
      { stdout: "2.1.330 (Claude Code)\n", code: 0 },
    ]);
    const read = yield* makeClaudeVersionReader();
    const readVersion = read(decodeClaudeSettings({ binaryPath: executable }), {
      PATH: dir,
    }).pipe(Effect.provide(layer));
    yield* readVersion;
    assert.equal(versionOutput(yield* readVersion), "2.1.330 (Claude Code)");
    yield* readVersion;
    assert.equal(runs.count, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
