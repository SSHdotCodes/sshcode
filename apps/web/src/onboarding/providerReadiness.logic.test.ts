import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getOnboardingProviderState,
  resolveAgentSetupRows,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "./providerReadiness.logic";

const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats an enabled Codex provider with ready status and unknown authentication as ready", () => {
    expect(getOnboardingProviderState(readyCodex)).toBe("ready");
  });

  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyCodex, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyCodex, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyCodex, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyCodex, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyCodex, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyCodex, installed: false, status: "error" })).toBe(
      "install",
    );
  });

  it("waits for a provider snapshot before offering an action", () => {
    expect(getOnboardingProviderState(undefined)).toBe("checking");
  });
});

describe("selectOnboardingProvidersByDriver", () => {
  it("prefers a ready instance with unknown authentication to an unauthenticated instance", () => {
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([signedOutCodex, readyCodex]).get("codex")).toBe(
      readyCodex,
    );
  });

  it("prefers a provider with an actionable sign-in over a failed provider", () => {
    const failedCodex: ServerProvider = { ...readyCodex, status: "error" };
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([failedCodex, signedOutCodex]).get("codex")).toBe(
      signedOutCodex,
    );
  });

  it("prefers installed providers over missing or disabled instances", () => {
    const disabledCodex: ServerProvider = { ...readyCodex, enabled: false };
    const missingCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      installed: false,
      status: "error",
    };

    expect(
      selectOnboardingProvidersByDriver([disabledCodex, missingCodex, readyCodex]).get("codex"),
    ).toBe(readyCodex);
  });

  it("handles provider snapshots that have not arrived", () => {
    expect(selectOnboardingProvidersByDriver(undefined).size).toBe(0);
  });

  it("keeps a ready custom account when the default account is signed out", () => {
    const signedOutDefault: ServerProvider = {
      ...readyCodex,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    const readyCustom: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
    };

    expect(selectOnboardingProvidersByDriver([signedOutDefault, readyCustom]).get("codex")).toBe(
      readyCustom,
    );
  });
});

describe("resolveOnboardingProviderLoginCommand", () => {
  it("uses the selected Codex account binary", () => {
    const provider = { ...readyCodex, instanceId: ProviderInstanceId.make("codex_work") };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/codex-work/bin/codex" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/codex-work/bin/codex login");
  });

  it("uses the selected Claude account binary", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude_work"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/claude-work/bin/claude" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/claude-work/bin/claude auth login");
  });

  it("quotes a Codex path with spaces for PowerShell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "C:\\Program Files\\Codex & Tools\\codex.exe",
              },
            },
          },
        },
        "windows",
      ),
    ).toBe("& 'C:\\Program Files\\Codex & Tools\\codex.exe' login");
  });

  it("quotes a Claude path with shell metacharacters on POSIX", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("claude")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: {
                binaryPath: "/opt/Claude Tools/$current/claude",
              },
            },
          },
        },
        "linux",
      ),
    ).toBe("'/opt/Claude Tools/$current/claude' auth login");
  });

  it.each([
    ["~/my tools/codex", "~/'my tools/codex' login"],
    ["~\\my tools/codex", "~/'my tools/codex' login"],
    ["~/tools/codex's build", `~/'tools/codex'"'"'s build' login`],
    ["~\\tools\\codex's build", `~/'tools\\codex'"'"'s build' login`],
    ["~/tools/codex; echo unsafe", "~/'tools/codex; echo unsafe' login"],
  ])("keeps the home prefix expandable while quoting %s", (binaryPath, expectedCommand) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath,
              },
            },
          },
        },
        "linux",
      ),
    ).toBe(expectedCommand);
  });

  it.each(["darwin", "linux"] as const)("quotes backslashes in a Codex path on %s", (platform) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "/opt/codex\\work/codex",
              },
            },
          },
        },
        platform,
      ),
    ).toBe("'/opt/codex\\work/codex' login");
  });

  it("keeps a plain Windows path unquoted", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "C:\\Tools\\codex.exe",
              },
            },
          },
        },
        "windows",
      ),
    ).toBe("C:\\Tools\\codex.exe login");
  });

  it("uses the default command when an old server reports an unknown shell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "/opt/Codex Tools/codex",
              },
            },
          },
        },
        "unknown",
      ),
    ).toBe("codex login");
  });
});

describe("resolveOnboardingProviderInstallCommand", () => {
  it("uses the PowerShell installer on Windows environments", () => {
    expect(resolveOnboardingProviderInstallCommand("codex", "windows")).toBe(
      "irm https://chatgpt.com/codex/install.ps1 | iex",
    );
    expect(resolveOnboardingProviderInstallCommand("claudeAgent", "windows")).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    );
  });

  it.each(["darwin", "linux", "unknown"] as const)("uses the shell installer on %s", (platform) => {
    expect(resolveOnboardingProviderInstallCommand("codex", platform)).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
    expect(resolveOnboardingProviderInstallCommand("claudeAgent", platform)).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
  });
});

describe("resolveAgentSetupRows", () => {
  const provider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
    ...readyCodex,
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    ...overrides,
  });
  const missing = (driver: string, overrides: Partial<ServerProvider> = {}) =>
    provider(driver, { installed: false, status: "error", version: null, ...overrides });
  // The snapshot a provider reports before its first probe of the session finishes.
  const unchecked = (driver: string) =>
    provider(driver, { installed: false, status: "warning", version: null });
  const signedOut = (driver: string) =>
    provider(driver, { status: "error", auth: { status: "unauthenticated" } });

  it("stays hidden until provider snapshots arrive", () => {
    expect(resolveAgentSetupRows(undefined, "darwin")).toBeNull();
    expect(resolveAgentSetupRows([], "darwin")).toBeNull();
  });

  it("stays hidden while any provider is still being checked, so a ready agent never flashes it", () => {
    expect(
      resolveAgentSetupRows([missing("codex"), unchecked("claudeAgent")], "darwin"),
    ).toBeNull();
  });

  it("lists each enabled harness with its status and one action when none is ready", () => {
    const rows = resolveAgentSetupRows(
      [
        missing("codex"),
        signedOut("claudeAgent"),
        missing("cursor"),
        missing("antigravity", { setup: { canAuthenticate: true, canInstall: true } }),
        provider("muse", { enabled: false, status: "disabled" }),
        provider("grok", { status: "warning" }),
      ],
      "darwin",
    );
    expect(rows?.map(({ provider, state, action }) => [provider.driver, state, action])).toEqual([
      [
        "codex",
        "install",
        {
          kind: "install",
          command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
          docsUrl: "https://developers.openai.com/codex/cli",
        },
      ],
      ["claudeAgent", "signIn", { kind: "settings", label: "Sign in" }],
      [
        "cursor",
        "install",
        {
          kind: "install",
          command: "curl https://cursor.com/install -fsS | bash",
          docsUrl: "https://cursor.com/cli",
        },
      ],
      // SSHCode installs Antigravity's runtime itself, from its settings.
      ["antigravity", "install", { kind: "settings", label: "Install" }],
      ["grok", "attention", { kind: "settings", label: "Set up" }],
    ]);
  });

  it("disappears once any agent is ready, including a second account of a driver", () => {
    expect(resolveAgentSetupRows([missing("codex"), provider("claudeAgent")], "darwin")).toBeNull();
    expect(
      resolveAgentSetupRows(
        [signedOut("codex"), provider("codex", { instanceId: ProviderInstanceId.make("work") })],
        "darwin",
      ),
    ).toBeNull();
  });

  it("counts an installed Antigravity whose saved login is checked at session start as ready", () => {
    expect(
      resolveAgentSetupRows(
        [
          missing("codex"),
          provider("antigravity", { status: "warning", auth: { status: "unknown" } }),
        ],
        "darwin",
      ),
    ).toBeNull();
  });

  it("stays hidden when every harness is turned off", () => {
    expect(
      resolveAgentSetupRows([provider("codex", { enabled: false, status: "disabled" })], "darwin"),
    ).toBeNull();
  });

  it("uses PowerShell installers on Windows and falls back to the docs where none is published", () => {
    const rows = resolveAgentSetupRows([missing("claudeAgent"), missing("cursor")], "windows");
    expect(rows?.map((row) => row.action)).toEqual([
      {
        kind: "install",
        command: "irm https://claude.ai/install.ps1 | iex",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
      { kind: "install", command: null, docsUrl: "https://cursor.com/cli" },
    ]);
  });
});
