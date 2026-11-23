// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  ClaudeExecutableFileCheck,
  resolveClaudeSdkExecutablePath,
  claudeProgramReader,
  claudeProgramWasReplaced,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("returns the configured path unchanged on non-Windows platforms", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("must not resolve on non-Windows platforms");
          }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("returns the resolved absolute path for native Windows executables", () =>
    Effect.gen(function* () {
      const nativeBinary = "C:\\Users\\dev\\.local\\bin\\claude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: nativeBinary }),
        ),
      ).toBe(nativeBinary);
    }),
  );

  it.effect("follows an npm launcher shim to the packaged native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE, NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("follows .bat and .ps1 launcher shims the same way", () =>
    Effect.gen(function* () {
      for (const shim of [`${NPM_DIR}\\claude.bat`, `${NPM_DIR}\\claude.ps1`]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [NPM_PACKAGE_EXE],
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }
    }),
  );

  it.effect("normalizes mixed-case shim extensions before matching", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: `${NPM_DIR}\\claude.CMD`,
            existingFiles: [NPM_PACKAGE_EXE],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("falls back to cli.js when the package ships no native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_CLI);
    }),
  );

  it.effect("returns the configured path when a shim has no known package entry", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("returns the configured path when command resolution finds nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: undefined }),
        ),
      ).toBe("claude");
    }),
  );
});

describe("claudeProgramReader", () => {
  /** An install as the Claude installer lays it out: one file per version and a link. */
  const withInstall = <A, E, R>(
    use: (install: {
      readonly bin: string;
      readonly link: string;
      readonly update: () => void;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-program-"))),
      (root) => {
        const bin = NodePath.join(root, "bin");
        const link = NodePath.join(bin, "claude");
        const version = (name: string) => {
          const file = NodePath.join(root, "versions", name);
          NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
          NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
          return file;
        };
        NodeFS.mkdirSync(bin);
        NodeFS.symlinkSync(version("1.0.0"), link);
        return use({
          bin,
          link,
          update: () => {
            NodeFS.unlinkSync(link);
            NodeFS.symlinkSync(version("1.0.1"), link);
          },
        });
      },
      (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );

  it.effect("reports an update that repoints the installed link", () =>
    withInstall(({ link, update }) =>
      Effect.gen(function* () {
        const readProgram = yield* claudeProgramReader(link, {});
        const startedFrom = readProgram();
        expect(claudeProgramWasReplaced(startedFrom, readProgram())).toBe(false);
        update();
        expect(claudeProgramWasReplaced(startedFrom, readProgram())).toBe(true);
        // A CLI started now runs the new version.
        expect(claudeProgramWasReplaced(readProgram(), readProgram())).toBe(false);
      }),
    ),
  );

  it.effect("follows a bare command name through PATH", () =>
    withInstall(({ bin, update }) =>
      Effect.gen(function* () {
        const readProgram = yield* claudeProgramReader("claude", { PATH: bin });
        const startedFrom = readProgram();
        expect(startedFrom).toBeDefined();
        update();
        expect(claudeProgramWasReplaced(startedFrom, readProgram())).toBe(true);
      }),
    ),
  );

  it.effect("reports nothing for a program it cannot find", () =>
    withInstall(({ bin, update }) =>
      Effect.gen(function* () {
        const readProgram = yield* claudeProgramReader("claude-missing", { PATH: bin });
        const startedFrom = readProgram();
        expect(startedFrom).toBeUndefined();
        update();
        expect(claudeProgramWasReplaced(startedFrom, readProgram())).toBe(false);
      }),
    ),
  );
});
