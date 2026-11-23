import {
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SharedSkill,
  type SharedSkillsList,
} from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { describe, expect, it } from "vite-plus/test";

import {
  dedupeProviderSkillsByName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
  publishSharedSkillsCatalog,
  readSharedSkillsCatalog,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  resolveProviderSkillSourceKind,
  subscribeSharedSkillsCatalog,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("dedupeProviderSkillsByName", () => {
  it("keeps the first resolved skill and preserves unrelated skill order", () => {
    const firstSkill = {
      name: "branch-audit",
      path: "/Users/matt/.codex/skills/branch-audit/SKILL.md",
      enabled: true,
    };
    const otherSkill = {
      name: "browser",
      path: "/Users/matt/.agents/skills/browser/SKILL.md",
      enabled: true,
    };
    const duplicateSkill = {
      name: "Branch-Audit",
      path: "/Users/matt/.agents/skills/branch-audit/SKILL.md",
      enabled: true,
    };

    expect(dedupeProviderSkillsByName([firstSkill, otherSkill, duplicateSkill])).toEqual([
      firstSkill,
      otherSkill,
    ]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("drops a skill the provider reserves for the agent", () => {
    const skills = [
      {
        name: "legacy-system-context",
        path: "/Users/matt/.claude/skills/legacy-system-context/SKILL.md",
        enabled: true,
        userInvocable: false,
      },
      {
        name: "deploy",
        path: "/Users/matt/.claude/skills/deploy/SKILL.md",
        enabled: true,
        // Reserved for the user, not the agent: still a valid pick.
        userInvocationOnly: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "deploy",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

const librarySkill = (name: string, enabled: boolean): SharedSkill => ({
  name,
  directoryName: name,
  path: `/Users/julius/.agents/skills/${name}/SKILL.md`,
  enabled,
  source: "elsewhere",
  origin: "Managed elsewhere",
  harnesses: "Claude, Codex, OpenCode, Grok, Cursor, Pi, Antigravity, Kimi, and Vibe",
  canRemove: false,
  canUpdate: false,
});

const sharedCatalog: SharedSkillsList = {
  libraryRoot: "/Users/julius/.agents/skills",
  skills: [librarySkill("local", true), librarySkill("review", true), librarySkill("quiet", false)],
};

describe("shared skill picker", () => {
  const mixed = {
    ...provider,
    skills: [
      { name: "review", path: "/Users/julius/.codex/skills/review/SKILL.md", enabled: true },
      { name: "review", path: "/Users/julius/.agents/skills/review/SKILL.md", enabled: true },
      { name: "quiet", path: "/Users/julius/.agents/skills/quiet/SKILL.md", enabled: true },
      { name: "local", path: "/Users/julius/.agents/skills/local/SKILL.md", enabled: true },
    ],
  } satisfies ServerProvider;

  it("keeps a native skill and adds an enabled library skill the provider has not listed", () => {
    expect(resolveProviderSkillsForCwd(mixed, null, { catalog: sharedCatalog })).toEqual([
      { name: "review", path: "/Users/julius/.codex/skills/review/SKILL.md", enabled: true },
      { name: "local", path: "/Users/julius/.agents/skills/local/SKILL.md", enabled: true },
    ]);
  });

  it("adds a library skill that the provider snapshot does not contain", () => {
    const catalog: SharedSkillsList = {
      ...sharedCatalog,
      skills: [...sharedCatalog.skills, librarySkill("notes", true)],
    };
    expect(
      resolveProviderSkillsForCwd(mixed, null, { catalog }).map((skill) => skill.name),
    ).toEqual(["review", "local", "notes"]);
  });

  it("leaves a harness that cannot load the library unchanged", () => {
    const generic = {
      ...mixed,
      driver: ProviderDriverKind.make("acpRegistry"),
      instanceId: ProviderInstanceId.make("mock-agent"),
    } satisfies ServerProvider;
    expect(
      resolveProviderSkillsForCwd(generic, null, { catalog: sharedCatalog, agentId: "mock-agent" }),
    ).toEqual(generic.skills);
    expect(
      resolveProviderSkillsForCwd({ ...generic, badgeLabel: "Kimi" }, null, {
        catalog: sharedCatalog,
      }).map((skill) => skill.name),
    ).toEqual(["review", "local"]);
  });

  it("keeps the two-argument snapshot when no catalog is passed", () => {
    expect(resolveProviderSkillsForCwd(mixed, "/workspace/project-b")).toEqual(mixed.skills);
  });

  it("offers Claude the plain skill name instead of a plugin alias", () => {
    const claude = {
      ...provider,
      driver: ProviderDriverKind.make("claudeAgent"),
      skills: [
        {
          name: "demo-skill:demo-skill",
          path: "/plugins/demo-skill/SKILL.md",
          enabled: true,
        },
        {
          name: "native",
          path: "/Users/julius/.claude/skills/native/SKILL.md",
          enabled: true,
        },
      ],
    } satisfies ServerProvider;
    const catalog: SharedSkillsList = {
      libraryRoot: "/Users/julius/.agents/skills",
      skills: [librarySkill("demo-skill", true)],
    };
    expect(
      resolveProviderSkillsForCwd(claude, null, { catalog }).map((skill) => skill.name),
    ).toEqual(["native", "demo-skill"]);
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });

  it("asks for a rescan once the workspace snapshot outlives its TTL", () => {
    const scannedAt = Date.parse("2026-01-01T00:01:00.000Z");
    const cwd = "/workspace/project-a";
    expect(hasCurrentProviderWorkspaceSnapshot(provider, cwd, scannedAt)).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
      ),
    ).toBe(false);
    expect(hasCurrentProviderWorkspaceSnapshot(provider, "/workspace/project-b", scannedAt)).toBe(
      false,
    );
  });
});

describe("shared skills catalog cache", () => {
  it("notifies readers only when a published list differs from the cached one", () => {
    const environmentId = "environment-shared-skills-cache";
    let notified = 0;
    const unsubscribe = subscribeSharedSkillsCatalog(() => {
      notified += 1;
    });
    try {
      publishSharedSkillsCatalog(environmentId, sharedCatalog);
      expect(notified).toBe(1);
      const cached = readSharedSkillsCatalog(environmentId);

      // Every chat that opens refetches the list; the same skills keep the cached object.
      publishSharedSkillsCatalog(environmentId, structuredClone(sharedCatalog));
      expect(notified).toBe(1);
      expect(readSharedSkillsCatalog(environmentId)).toBe(cached);

      const changed: SharedSkillsList = {
        ...sharedCatalog,
        skills: [...sharedCatalog.skills, librarySkill("notes", true)],
      };
      publishSharedSkillsCatalog(environmentId, changed);
      expect(notified).toBe(2);
      expect(readSharedSkillsCatalog(environmentId)).toEqual(changed);
    } finally {
      unsubscribe();
    }
  });
});
