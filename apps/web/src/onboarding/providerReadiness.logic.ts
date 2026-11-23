import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const SAFE_SHELL_BINARY_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_BINARY_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

const PROVIDER_STATE_PRIORITY = {
  checking: 0,
  disabled: 1,
  install: 2,
  attention: 3,
  signIn: 4,
  ready: 5,
} as const;

/** Select the most usable configured instance for each provider driver. */
export function selectOnboardingProvidersByDriver(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
) {
  const providersByDriver = new Map<string, ServerProvider>();

  for (const provider of providers ?? []) {
    const existing = providersByDriver.get(provider.driver);
    if (
      existing === undefined ||
      PROVIDER_STATE_PRIORITY[getOnboardingProviderState(provider)] >
        PROVIDER_STATE_PRIORITY[getOnboardingProviderState(existing)]
    ) {
      providersByDriver.set(provider.driver, provider);
    }
  }

  return providersByDriver;
}

/**
 * Official standalone installers. Neither needs Node or npm, and both land in
 * the paths the server's provider maintenance recognizes as native, so the
 * one-click updater in Settings keeps working after install.
 */
const NATIVE_INSTALL_COMMANDS = {
  claudeAgent: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    windows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
} as const;

/**
 * Install command for the setup terminal, keyed on the environment's platform
 * (not the client's): a Windows desktop driving a WSL server gets the shell
 * script. Unknown platforms get the shell script too, since the terminal there
 * is a POSIX shell in practice.
 */
export function resolveOnboardingProviderInstallCommand(
  driver: keyof typeof NATIVE_INSTALL_COMMANDS,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const commands = NATIVE_INSTALL_COMMANDS[driver];
  return platform === "windows" ? commands.windows : commands.posix;
}

/** Use the selected provider instance's binary when the setup terminal opens its login flow. */
export function resolveOnboardingProviderLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const instance = settings.providerInstances[provider.instanceId];

  if (provider.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance?.config ?? {});
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "claude";
    return `${quoteProviderBinary(binaryPath, "claude", platform)} auth login`;
  }

  if (provider.driver === "codex") {
    const config = decodeCodexSettings(instance?.config ?? {});
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "codex";
    return `${quoteProviderBinary(binaryPath, "codex", platform)} login`;
  }

  return provider.driver;
}

/**
 * Official one-line installers (macOS and Linux shells, plus PowerShell where the
 * vendor publishes one) and setup docs for the new chat's "Set up an agent" card.
 * Drivers SSHCode installs itself (`setup.canInstall`) open their settings instead.
 */
const AGENT_SETUP_GUIDES: Readonly<
  Record<string, { readonly posix?: string; readonly windows?: string; readonly docsUrl: string }>
> = {
  codex: { ...NATIVE_INSTALL_COMMANDS.codex, docsUrl: "https://developers.openai.com/codex/cli" },
  claudeAgent: {
    ...NATIVE_INSTALL_COMMANDS.claudeAgent,
    docsUrl: "https://code.claude.com/docs/en/setup",
  },
  cursor: {
    posix: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://cursor.com/cli",
  },
  grok: {
    posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    windows: "irm https://x.ai/cli/install.ps1 | iex",
    docsUrl: "https://docs.x.ai/build/overview",
  },
  opencode: {
    posix: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs",
  },
  antigravity: {
    posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    windows: "irm https://antigravity.google/cli/install.ps1 | iex",
    docsUrl: "https://antigravity.google/docs/cli/install",
  },
  pi: {
    posix: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    windows: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    docsUrl: "https://pi.dev",
  },
  muse: { docsUrl: "https://dev.meta.ai/docs/muse-code" },
};

export type AgentSetupAction =
  /** Copy the installer (when there is one) and open the docs. */
  | { readonly kind: "install"; readonly command: string | null; readonly docsUrl: string }
  /** Open the provider's own setup in Settings › Providers. */
  | { readonly kind: "settings"; readonly label: "Install" | "Sign in" | "Set up" };

export interface AgentSetupRow {
  readonly provider: ServerProvider;
  readonly state: "install" | "signIn" | "attention";
  readonly action: AgentSetupAction;
}

/**
 * Antigravity checks its saved Google login only when a session starts, so after a
 * restart an installed runtime reads as unknown auth. That is usable, not a problem.
 */
function isUsableProvider(provider: ServerProvider): boolean {
  return (
    getOnboardingProviderState(provider) === "ready" ||
    (provider.driver === "antigravity" &&
      provider.enabled &&
      provider.installed &&
      provider.status === "warning" &&
      provider.auth.status === "unknown")
  );
}

function resolveAgentSetupAction(
  provider: ServerProvider,
  state: AgentSetupRow["state"],
  platform: ExecutionEnvironmentPlatformOs,
): AgentSetupAction {
  if (state === "signIn") return { kind: "settings", label: "Sign in" };
  if (state === "attention") return { kind: "settings", label: "Set up" };
  const guide = AGENT_SETUP_GUIDES[provider.driver];
  if (provider.setup?.canInstall === true || guide === undefined) {
    return { kind: "settings", label: "Install" };
  }
  const command = (platform === "windows" ? guide.windows : guide.posix) ?? null;
  return { kind: "install", command, docsUrl: guide.docsUrl };
}

/**
 * One row per enabled agent harness for the new chat's setup card, or null when the
 * card stays hidden: before provider snapshots arrive, while any is still being
 * checked (so a ready agent never flashes the card at startup), and once any agent
 * is usable. Settings › Providers stays the place to add more after that.
 */
export function resolveAgentSetupRows(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  platform: ExecutionEnvironmentPlatformOs,
): ReadonlyArray<AgentSetupRow> | null {
  if (!providers || providers.some(isUsableProvider)) return null;
  const rows: AgentSetupRow[] = [];
  for (const provider of selectOnboardingProvidersByDriver(providers).values()) {
    const state = getOnboardingProviderState(provider);
    if (state === "checking") return null;
    if (state === "disabled" || state === "ready") continue;
    rows.push({ provider, state, action: resolveAgentSetupAction(provider, state, platform) });
  }
  return rows.length > 0 ? rows : null;
}
