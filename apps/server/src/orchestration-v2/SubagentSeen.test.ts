import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commitsSinceArgs,
  ownSubagentCheckout,
  seenLineForLead,
  shortCommand,
  subagentSeen,
} from "./SubagentSeen.ts";

let ordinal = 0;
const command = (
  input: string,
  result: { readonly exitCode?: number; readonly status?: "completed" | "failed" | "running" },
) =>
  ({
    type: "command_execution",
    input,
    status: result.status ?? "completed",
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ordinal: ordinal++,
  }) as unknown as OrchestrationV2TurnItem;
const fileChange = (fileName: string, paths?: ReadonlyArray<string>) =>
  ({
    type: "file_change",
    fileName,
    status: "completed",
    ...(paths === undefined
      ? {}
      : { changes: paths.map((path) => ({ operation: "update", path })) }),
  }) as unknown as OrchestrationV2TurnItem;

describe("subagentSeen", () => {
  it("counts commands, failures, the last check, files, commits and time", () => {
    expect(
      subagentSeen({
        turnItems: [
          command("/bin/zsh -lc 'cd /repo && pnpm exec tsc-rs --noEmit'", { exitCode: 2 }),
          command("rg foo", { exitCode: 0 }),
          // Claude records no exit code; a failed status counts.
          command("cd /repo && vp lint src", { status: "failed" }),
          command("TMPDIR=/tmp pnpm exec vp test run src/a.test.ts", { exitCode: 0 }),
          command("sleep 100", { status: "running" }),
          fileChange("src/a.ts"),
          fileChange("src/b.ts", ["src/b.ts", "src/c.ts"]),
          fileChange("src/a.ts"),
        ],
        commits: ["1a2b3c4", "5d6e7f8"],
        seconds: 372.4,
      }),
    ).toEqual({
      commands: 4,
      failed: 2,
      failing: ["pnpm exec tsc-rs --noEmit", "vp lint src"],
      check: { command: "TMPDIR=/tmp pnpm exec vp test run src/a.test.ts", passed: true },
      files: 3,
      commits: ["1a2b3c4", "5d6e7f8"],
      seconds: 372,
    });
  });

  it("states a check's result only when the exit code was its own", () => {
    const check = (line: string, exitCode: number) =>
      subagentSeen({ turnItems: [command(line, { exitCode })], commits: [], seconds: 0 })?.check;
    // `tsc | tail` exits with tail's code, `; echo $?` with echo's.
    expect(check("pnpm exec vp test run a.test.ts 2>&1 | tail -5", 0)).toEqual({
      command: "pnpm exec vp test run a.test.ts 2>&1 | tail -5",
    });
    expect(check("pnpm exec tsc-rs --noEmit > log 2>&1; echo $?", 0)?.passed).toBeUndefined();
    expect(check("pnpm exec tsc-rs --noEmit || true", 0)?.passed).toBeUndefined();
    // A project's own test script counts as a check too.
    expect(check("zsh scripts/sshcode-release/selftest.sh", 0)?.passed).toBe(true);
    expect(check("npm test", 1)?.passed).toBe(false);
    expect(check("npm test & echo done", 0)?.passed).toBeUndefined();
    expect(check("/bin/zsh -lc 'cd /repo && pnpm exec tsc-rs --noEmit 2>&1'", 0)?.passed).toBe(
      true,
    );
    expect(check("pnpm exec tsc-rs --noEmit && pnpm exec vp test run a.test.ts", 1)?.passed).toBe(
      false,
    );
  });

  it("ignores check names in search terms, shell arguments and similarly named scripts", () => {
    for (const input of [
      "rg 'npm test' README.md",
      "echo npm test",
      "echo 'something && npm test'",
      "/bin/zsh -lc 'cd /repo && printf vitest'",
      "npm run test-data",
      "pnpm exec rg pytest",
    ]) {
      expect(
        subagentSeen({ turnItems: [command(input, { exitCode: 0 })], commits: [], seconds: 0 }),
      ).toEqual({ commands: 1 });
    }
  });

  it("only attributes commits to a checkout created for the child", () => {
    const worktree = { workspacePreparation: { type: "worktree" as const, baseRef: "HEAD" } };
    expect(ownSubagentCheckout("/lead", "/lead", [{}])).toBeNull();
    expect(
      ownSubagentCheckout("/shared", "/lead", [
        { workspacePreparation: { type: "existing_worktree", worktreePath: "/shared" } },
      ]),
    ).toBeNull();
    expect(ownSubagentCheckout("/child", "/lead", [worktree, {}])).toBe("/child");
    expect(
      ownSubagentCheckout("/shared", "/lead", [
        worktree,
        { workspacePreparation: { type: "existing_worktree", worktreePath: "/shared" } },
      ]),
    ).toBeNull();
  });

  it("leaves out what it did not see", () => {
    expect(subagentSeen({ turnItems: [], commits: [], seconds: null })).toBeUndefined();
    expect(
      subagentSeen({ turnItems: [command("ls", { exitCode: 0 })], commits: [], seconds: 0 }),
    ).toEqual({ commands: 1 });
  });

  it("stays under its size cap, keeping at most 3 failing lines and 5 commits", () => {
    const long = (n: number) => `pnpm exec vp test run ${"x".repeat(120)}${n}`;
    const seen = subagentSeen({
      turnItems: Array.from({ length: 6 }, (_, n) => command(long(n), { exitCode: 1 })),
      commits: ["a1", "b2", "c3", "d4", "e5", "f6"].map((id) => `${id}aaaaa`),
      seconds: 10,
    })!;
    expect(JSON.stringify(seen).length).toBeLessThanOrEqual(400);
    expect(seen.failed).toBe(6);
    expect(seen.failing?.length ?? 0).toBeLessThanOrEqual(3);
    expect(seen.commits).toHaveLength(5);
    expect(seen.check?.passed).toBe(false);
  });
});

describe("seenLineForLead", () => {
  it("is one short line of what the app recorded", () => {
    expect(
      seenLineForLead({
        commands: 12,
        failed: 1,
        failing: ["rg nothing"],
        check: { command: "pnpm exec vp test run src/a.test.ts", passed: true },
        files: 3,
        commits: ["1a2b3c4", "5d6e7f8"],
        seconds: 372,
      }),
    ).toBe(
      "App saw: check passed: pnpm exec vp test run src/a.test.ts; 12 commands, 1 failed; 3 files; commits 1a2b3c4 5d6e7f8; 6m",
    );
    expect(seenLineForLead({ check: { command: "tsc | tail" }, seconds: 40 })).toBe(
      "App saw: check ran, result unseen: tsc | tail; 40s",
    );
    expect(seenLineForLead({ check: { command: "tsc", passed: false }, seconds: 7200 })).toBe(
      "App saw: check FAILED: tsc; 2h",
    );
  });
});

describe("shortCommand", () => {
  it("drops shell wrappers and cuts long lines", () => {
    expect(shortCommand('/bin/zsh -lc "cd /a/b && go test ./..."')).toBe("go test ./...");
    expect(shortCommand(`echo ${"y".repeat(200)}`)).toHaveLength(80);
  });
});

describe("commitsSinceArgs", () => {
  it("asks Git for at most 5 short ids since the start", () => {
    expect(commitsSinceArgs(1_700_000_000_999)).toEqual([
      "log",
      "--since=@1700000000",
      "--max-count=5",
      "--format=%h",
      "HEAD",
    ]);
  });
});
