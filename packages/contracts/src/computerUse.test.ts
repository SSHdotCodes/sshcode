import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ComputerAction, ComputerUseSettings } from "./computerUse.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "./settings.ts";
import { requiredScopesForServerSettingsPatch } from "./settings.ts";

const decodeComputerUseSettings = Schema.decodeSync(ComputerUseSettings);
const decodeSettingsPatch = Schema.decodeSync(ServerSettingsPatch);
const decodeAction = Schema.decodeUnknownSync(ComputerAction);

describe("computer use contracts", () => {
  it("requires one environment opt in without adding per-action approvals", () => {
    expect(decodeComputerUseSettings({})).toEqual({
      enabled: false,
      blockedAppIds: [],
    });
    expect(DEFAULT_SERVER_SETTINGS.computerUse.enabled).toBe(false);
    const patch = decodeSettingsPatch({
      computerUse: { enabled: true, blockedAppIds: [] },
    });
    expect(requiredScopesForServerSettingsPatch(patch)).toEqual(["settings:write"]);
  });

  it("requires capture identity for coordinate actions and bounds typing", () => {
    const decode = decodeAction;
    expect(() => decode({ kind: "clickAt", x: 10, y: 20 })).toThrow();
    expect(decode({ kind: "clickAt", captureId: "capture-1", x: 10, y: 20 })).toMatchObject({
      captureId: "capture-1",
    });
    expect(() => decode({ kind: "type", text: "x".repeat(20_001) })).toThrow();
    expect(() => decode({ kind: "scroll", direction: "down", amount: 100 })).toThrow();
  });
});
