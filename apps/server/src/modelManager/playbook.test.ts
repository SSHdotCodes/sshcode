import { describe, expect, it } from "vite-plus/test";

import { modelManagerPlaybook, pathEnvironmentOf } from "./playbook.ts";

describe("model manager playbook", () => {
  it("lists the harnesses with their binaries and config folders", () => {
    const playbook = modelManagerPlaybook([
      { instanceId: "pi", driver: "pi", displayName: "Pi", enabled: false, binaryPath: "pi" },
      {
        instanceId: "acpRegistry_kimi",
        driver: "acpRegistry",
        displayName: "Kimi Code",
        enabled: true,
        pathEnvironment: { KIMI_CODE_HOME: "/Users/me/.t3/userdata/provider-homes/kimi-code" },
      },
    ]);
    expect(playbook).toContain("- Pi: instance `pi`, driver `pi`, binary `pi`, off in SSHCode");
    expect(playbook).toContain("KIMI_CODE_HOME=`/Users/me/.t3/userdata/provider-homes/kimi-code`");
    expect(playbook).toContain("Never print, copy, move or log an API key");
  });

  it("keeps only path-valued environment overrides", () => {
    expect(
      pathEnvironmentOf({
        KIMI_CODE_HOME: "/Users/me/kimi",
        OPENROUTER_API_KEY: "sk-or-secret",
        TOKEN_DIR: "/tmp/tokens",
        CODEX_HOME: "relative/path",
        XDG_CONFIG_HOME: "~/.config",
      }),
    ).toEqual({ KIMI_CODE_HOME: "/Users/me/kimi", XDG_CONFIG_HOME: "~/.config" });
    expect(
      pathEnvironmentOf([{ name: "PI_CODING_AGENT_DIR", value: "/Users/me/.pi/agent" }]),
    ).toEqual({
      PI_CODING_AGENT_DIR: "/Users/me/.pi/agent",
    });
    expect(pathEnvironmentOf(undefined)).toBeUndefined();
  });
});
