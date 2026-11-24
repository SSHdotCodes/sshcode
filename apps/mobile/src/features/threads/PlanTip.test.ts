import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { betterPlanTip } from "@t3tools/shared/planTip";
import { describe, expect, it } from "vite-plus/test";
import { nextPlanTipDisplay, planTipKey } from "@t3tools/client-runtime/plan-tip";

import { resolveProvidersEnabledForProject } from "../../lib/modelOptions";

describe("phone plan tip visibility", () => {
  const pair = { fromInstanceId: "claudeAgent_work", toInstanceId: "claudeAgent" };
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const key = planTipKey("phone-environment:chat", pair);

  it("waits until the model sheet or composer takeover closes before first showing", () => {
    const seen = new Set<string>();
    expect(nextPlanTipDisplay(key, null, true, seen, now)).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toEqual({
      key,
      expiresAt: now + 12_000,
    });
  });

  it("keeps one pair visible as its percentages change", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, false, new Set([key]), now)?.key,
    ).toBe(key);
  });

  it("closes on a takeover or when the selection no longer qualifies", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, true, new Set([key]), now),
    ).toBeNull();
    expect(
      nextPlanTipDisplay(null, { key, expiresAt: now + 12_000 }, false, new Set([key]), now),
    ).toBeNull();
  });

  it("remembers dismiss, switching and the 12 second expiry across composer remounts", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, false, new Set([key]), now + 11_999)
        ?.key,
    ).toBe(key);
    expect(
      nextPlanTipDisplay(
        key,
        { key, expiresAt: now + 12_000 },
        false,
        new Set([key]),
        now + 12_000,
      ),
    ).toBeNull();
    const seen = new Set([key]);
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toBeNull();
    const otherChat = planTipKey("phone-environment:other-chat", pair);
    expect(nextPlanTipDisplay(otherChat, null, false, seen, now)?.key).toBe(otherChat);
    const otherEnvironment = planTipKey("other-environment:chat", pair);
    expect(nextPlanTipDisplay(otherEnvironment, null, false, seen, now)?.key).toBe(
      otherEnvironment,
    );
  });

  it("excludes accounts disabled for the selected project when building plan tip providers", () => {
    const projectId = ProjectId.make("project-a");
    const makeAccount = (instanceId: string, usedPercent: number): ServerProvider => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: instanceId,
      continuation: { groupKey: "claude:home:/synthetic/.claude" },
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-16T12:00:00.000Z",
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: "2026-11-16T12:00:00.000Z",
        windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent }],
      },
    });
    const config = {
      providers: [makeAccount("claudeAgent", 90), makeAccount("claudeAgent_max2", 5)],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          ...DEFAULT_SERVER_SETTINGS.providerInstances,
          [ProviderInstanceId.make("claudeAgent_max2")]: {
            id: ProviderInstanceId.make("claudeAgent_max2"),
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
          },
        },
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent_max2")]: { enabled: false },
            },
          },
        },
      },
    };
    const filtered = resolveProvidersEnabledForProject(config, projectId);
    expect(
      betterPlanTip(filtered, { instanceId: "claudeAgent", model: "claude-opus-5-5" }, { now }),
    ).toBeNull();
    // Another project without the override still gets the tip.
    expect(
      betterPlanTip(
        resolveProvidersEnabledForProject(config, ProjectId.make("project-b")),
        { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        { now },
      )?.toInstanceId,
    ).toBe("claudeAgent_max2");
  });
});
