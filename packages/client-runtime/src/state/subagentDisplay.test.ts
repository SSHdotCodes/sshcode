import { ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  subagentSeenLine,
  subagentGroupSummary,
  resolveSubagentMetadata,
  subagentCardDetail,
  subagentDetailPreview,
  subagentSpeed,
} from "./subagentDisplay.js";

describe("subagentGroupSummary", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "keeps a mixed group live while a member is %s",
    (status) => {
      expect(subagentGroupSummary([{ status: "completed" }, { status }])).toEqual({
        label: "Kicked off 2 subagents",
        active: true,
        failed: false,
      });
    },
  );

  it("settles the label without disguising a failed member as success", () => {
    const statuses: OrchestrationV2TurnItemStatus[] = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    expect(subagentGroupSummary(statuses.map((status) => ({ status })))).toEqual({
      label: "Ran 4 subagents",
      active: false,
      failed: true,
    });
  });

  it("uses a singular label for one idle member", () => {
    expect(subagentGroupSummary([{ status: "idle" }])).toEqual({
      label: "Ran 1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe("resolveSubagentMetadata", () => {
  it("resolves provider aliases to catalog names, including custom models", () => {
    expect(
      resolveSubagentMetadata({
        model: "claude-haiku-4-5-20251001",
        provider: {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              slug: "claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              shortName: "Haiku 4.5",
              aliases: ["claude-haiku-4-5-20251001"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("Haiku 4.5");
    expect(
      resolveSubagentMetadata({
        model: "my-model",
        provider: {
          driver: ProviderDriverKind.make("acpRegistry"),
          models: [
            {
              slug: "my-model",
              name: "Cloud+ / My custom model",
              subProvider: "Cloud+",
              isCustom: true,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("My custom model");
  });

  it("keeps unknown model identities and does not invent an unreported model", () => {
    expect(resolveSubagentMetadata({ model: " custom/model " }).modelLabel).toBe("custom/model");
    expect(
      resolveSubagentMetadata({
        model: null,
        provider: { driver: ProviderDriverKind.make("codex"), models: [] },
      }).modelLabel,
    ).toBe("Not reported");
    expect(resolveSubagentMetadata({ model: " " }).modelLabel).toBe("Not reported");
  });

  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("shows another project and its branch when the child has a different workspace", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "fix/agents", worktreePath: "/worktrees/agents" },
        childProject: {
          id: ProjectId.make("child"),
          title: "Other project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([
      { label: "Project", value: "Other project" },
      { label: "Branch", value: "fix/agents" },
    ]);
  });

  it("labels a detached worktree or another project workspace without a branch", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: null, worktreePath: "/worktrees/agents" },
      }).workspace,
    ).toEqual([{ label: "Worktree", value: "agents" }]);
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childProject: {
          id: parentThread.projectId,
          title: "Same project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([{ label: "Workspace", value: "other" }]);
  });

  it("hides redundant workspace metadata and tolerates unavailable child shells", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "main", worktreePath: "/repo" },
        childProject: { id: parentThread.projectId, title: "Same project", workspaceRoot: "/repo" },
      }).workspace,
    ).toEqual([]);
    expect(resolveSubagentMetadata({ model: null, parentThread, parentProject }).workspace).toEqual(
      [],
    );
  });
});

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

it.each([279, 280, 281])("preserves the preview boundary at %i characters", (length) => {
  const result = "x".repeat(length);
  expect(subagentDetailPreview({ status: "completed", result })).toBe(
    length > 280 ? "x".repeat(280) + "…" : result,
  );
});

it("normalizes Unicode whitespace and ignores a large hidden suffix", () => {
  const progress = " \u00a0Reading\tfiles\n" + "x".repeat(1_000_000);
  expect(subagentDetailPreview({ status: "running", progress })).toBe(
    "Reading files " + "x".repeat(266) + "…",
  );
  expect(
    subagentDetailPreview({ status: "completed", result: "x".repeat(280) + " \n\u2028" }),
  ).toBe("x".repeat(280));
  expect(subagentDetailPreview({ status: "completed", result: "x".repeat(279) + " \n y" })).toBe(
    "x".repeat(279) + "…",
  );
  expect(
    subagentDetailPreview({ status: "running", progress: "\uFEFF\u2029", result: " Done " }),
  ).toBe("Done");
  expect(subagentDetailPreview({ status: "failed", result: "x".repeat(279) + "😀" })).toBe(
    "x".repeat(279) + "\uD83D…",
  );
});

describe("subagentSeenLine", () => {
  it("reads the facts the app saw, leaving out time", () => {
    expect(
      subagentSeenLine({
        seen: {
          commands: 12,
          failed: 1,
          check: { command: "tsc", passed: true },
          files: 1,
          commits: ["a1b2c3d", "e4f5a6b"],
          seconds: 300,
        },
      }),
    ).toBe("checks passed · 1 file · 2 commits");
    // A piped check ran, but the app cannot say how it ended.
    expect(subagentSeenLine({ seen: { check: { command: "tsc | tail" }, files: 2 } })).toBe(
      "2 files",
    );
    expect(subagentSeenLine({ seen: { seconds: 4 } })).toBeNull();
    expect(subagentSeenLine({})).toBeNull();
  });
});

describe("subagentCardDetail", () => {
  it.each([
    ["![screenshot](screenshots/shot.png) Verified", "screenshot Verified"],
    ["[docs](https://en.wikipedia.org/wiki/T3_(protocol))", "docs"],
    ["[report](outputs/report%20(final).md)", "report"],
    ["[report](outputs/report\\(final.md)", "report"],
  ])("strips image and link markup from %s", (detail, expected) => {
    expect(subagentCardDetail(detail)).toBe(expected);
  });
});

describe("subagentSpeed", () => {
  it("reads Codex's service tier and Claude's fast mode, and nothing slower", () => {
    const options = (...pairs: Array<[string, string | boolean]>) => ({
      options: pairs.map(([id, value]) => ({ id, value })),
    });
    expect(subagentSpeed(options(["serviceTier", "ultrafast"], ["reasoningEffort", "high"]))).toBe(
      "ultrafast",
    );
    expect(subagentSpeed(options(["serviceTier", "fast"]))).toBe("fast");
    expect(subagentSpeed(options(["reasoningEffort", "ultra"], ["serviceTier", "priority"]))).toBe(
      "fast",
    );
    expect(subagentSpeed(options(["fastMode", true]))).toBe("fast");
    expect(subagentSpeed(options(["fastMode", false]))).toBeNull();
    expect(subagentSpeed(options(["serviceTier", "default"]))).toBeNull();
    expect(subagentSpeed(options(["serviceTier", "flex"]))).toBeNull();
    expect(subagentSpeed(undefined)).toBeNull();
  });
});

describe("subagentSpeed", () => {
  it("reads an ACP Speed's fast choice as fast", () => {
    expect(subagentSpeed({ options: [{ id: "speed", value: "fast" }] })).toBe("fast");
    expect(subagentSpeed({ options: [{ id: "speed", value: "standard" }] })).toBeNull();
  });
});
