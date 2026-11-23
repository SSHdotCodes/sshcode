import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { runningChatAccountTip } from "./planTip.ts";

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const model = "claude-fable-5-2";

function weekly(usedPercent: number, hoursLeft: number): ServerProviderUsageWindow {
  return {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + hoursLeft * 3_600_000)),
    windowDurationMins: 10_080,
  };
}

function account(instanceId: string, displayName: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", label: "Claude Ultra Subscription" },
    checkedAt: "2026-11-17T08:00:00.000Z",
    models: [{ slug: model, name: "Fable 5.2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-11-17T08:00:00.000Z", windows: [weekly(usedPercent, 40)] },
  };
}

describe("runningChatAccountTip", () => {
  it("names both accounts the way the picker does and says why", () => {
    const providers = [
      account("claudeAgent", "Max 1", 97),
      account("claudeAgent_work", "Max 2", 20),
    ];
    expect(runningChatAccountTip(providers, { instanceId: "claudeAgent", model }, NOW)).toEqual({
      toInstanceId: "claudeAgent_work",
      to: "Max 2",
      message: "Max 1 has 3% of its Weekly limit left.",
    });
    // From the roomy account there is nothing to suggest.
    expect(
      runningChatAccountTip(providers, { instanceId: "claudeAgent_work", model }, NOW),
    ).toBeNull();
  });

  it("leaves out an account this chat cannot use", () => {
    const providers = [
      account("claudeAgent", "Max 1", 97),
      account("claudeAgent_work", "Max 2", 20),
    ];
    expect(
      runningChatAccountTip(
        providers,
        { instanceId: "claudeAgent", model },
        NOW,
        (provider) => provider.instanceId !== "claudeAgent_work",
      ),
    ).toBeNull();
  });
});
