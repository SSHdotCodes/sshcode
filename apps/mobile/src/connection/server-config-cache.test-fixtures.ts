import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";

export function cachedConfigFixture(providerCount = 1, workspaceCount = 3): ServerConfig {
  const providers: ServerProvider[] = Array.from({ length: providerCount }, (_, index) => {
    const skills = Array.from({ length: 30 }, (_, skill) => ({
      name: `skill-${skill}`,
      path: `/skills/${skill}`,
      description: "Synthetic cached workspace guidance. ".repeat(6),
      enabled: true,
    }));
    const slashCommands = [{ name: "help", description: "Show help" }];
    return {
      instanceId: ProviderInstanceId.make(`provider-${index}`),
      driver: ProviderDriverKind.make("test-driver"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-26T12:00:00.000Z",
      models: [],
      skills,
      slashCommands,
      workspaceSnapshots: Array.from({ length: workspaceCount }, (_, workspace) => ({
        cwd: `/workspace/${workspace}`,
        checkedAt: "2026-10-26T12:00:00.000Z",
        skills,
        slashCommands,
      })),
    };
  });
  return {
    environment: {
      environmentId: EnvironmentId.make("cache-fixture"),
      label: "Fixture",
      platform: { os: "linux", arch: "x64", machine: "server" },
      orchestrationProtocolVersion: 2,
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: true },
    },
    cwd: "/workspace",
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers,
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}
