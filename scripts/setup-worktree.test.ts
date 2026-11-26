// @effect-diagnostics nodeBuiltinImport:off - Isolated worktree setup CLI fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { useTempDirs } from "@t3tools/shared/testing/tempDirs";
import { expect, it } from "vite-plus/test";

const makeTempDir = useTempDirs();
const linksSupported = HostProcess.Platform.defaultValue() !== "win32";

it.each([
  { name: "user-created", subagent: "0", phase: "", installs: true, warms: true, links: true },
  { name: "subagent", subagent: "1", phase: "", installs: true, warms: false, links: true },
  {
    name: "warm fill",
    subagent: "1",
    phase: "prepare",
    installs: true,
    warms: false,
    links: false,
  },
  { name: "warm claim", subagent: "1", phase: "reuse", installs: false, warms: false, links: true },
] as const)(
  "$name worktrees run the appropriate setup stages",
  ({ subagent, phase, installs, warms, links }) => {
    const root = makeTempDir("sshcode-worktree-setup-");
    const bin = NodePath.join(root, "bin");
    const project = NodePath.join(root, "project");
    const worktree = NodePath.join(root, "worktree");
    const scripts = NodePath.join(worktree, "scripts");
    const webScripts = NodePath.join(worktree, "apps", "web", "scripts");
    const vpBin = NodePath.join(worktree, "node_modules", "vite-plus", "bin");
    for (const directory of [bin, project, scripts, webScripts, vpBin]) {
      NodeFS.mkdirSync(directory, { recursive: true });
    }
    NodeFS.copyFileSync(
      NodePath.join(import.meta.dirname, "setup-worktree.ts"),
      NodePath.join(scripts, "setup-worktree.mts"),
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "vp"),
      '#!/bin/sh\n[ "$1" = --version ] || touch installed\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "vp.cmd"),
      '@if not "%1"=="--version" type nul > installed\r\n',
    );
    NodeFS.writeFileSync(
      NodePath.join(webScripts, "warm-dep-cache.ts"),
      'require("node:fs").writeFileSync("warmed", "");\n',
    );
    if (linksSupported) {
      NodeFS.writeFileSync(NodePath.join(project, ".env"), "FIXTURE=1\n");
    }
    NodeFS.writeFileSync(
      NodePath.join(vpBin, "vp"),
      'require("node:fs").writeFileSync("configured-hooks", "");\n',
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(scripts, "setup-worktree.mts")],
      {
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH].filter(Boolean).join(NodePath.delimiter),
          T3CODE_PROJECT_ROOT: project,
          T3CODE_SUBAGENT_WORKTREE: subagent,
          T3CODE_WORKTREE_SETUP_CACHE: phase,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(worktree, "installed"))).toBe(installs);
    expect(NodeFS.existsSync(NodePath.join(worktree, "warmed"))).toBe(warms);
    expect(NodeFS.existsSync(NodePath.join(worktree, ".env"))).toBe(links && linksSupported);
    expect(NodeFS.existsSync(NodePath.join(worktree, "configured-hooks"))).toBe(phase === "reuse");
  },
);
