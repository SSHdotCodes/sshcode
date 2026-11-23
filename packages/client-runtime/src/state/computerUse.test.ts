import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ComputerDriverStatus,
  type ComputerUseStatus,
} from "@t3tools/contracts";

import {
  computerUseAvailabilityLabel,
  computerUseChatStatus,
  computerUseControllerSummary,
  computerUseReadiness,
  computerUseSetupSummary,
  createComputerUseCommandCoordinator,
  formatBlockedAppIds,
  parseBlockedAppIds,
} from "./computerUse.ts";

const readyDriver: ComputerDriverStatus = {
  platform: "darwin",
  installed: true,
  accessibility: "granted",
  screenRecording: "granted",
  reason: null,
};

function makeStatus(overrides: Partial<ComputerUseStatus> = {}): ComputerUseStatus {
  return {
    supported: true,
    enabled: true,
    paused: false,
    driver: readyDriver,
    owner: null,
    queued: [],
    blockedAppIds: [],
    ...overrides,
  };
}

describe("blocked app identifiers", () => {
  it("trims comma and newline separated values and removes duplicates", () => {
    expect(
      parseBlockedAppIds(
        "com.apple.Safari, com.apple.mail\ncom.apple.Safari\n\n com.tencent.wechat ",
      ),
    ).toEqual(["com.apple.Safari", "com.apple.mail", "com.tencent.wechat"]);
  });

  it("round trips the editor representation", () => {
    const identifiers = ["com.apple.Safari", "com.apple.mail"];
    expect(parseBlockedAppIds(formatBlockedAppIds(identifiers))).toEqual(identifiers);
    expect(parseBlockedAppIds(" \n, ")).toEqual([]);
  });
});

describe("createComputerUseCommandCoordinator", () => {
  it("lets takeover bypass hung ordinary work and rejects its late response", () => {
    const coordinator = createComputerUseCommandCoordinator();
    const setupEpoch = coordinator.beginOrdinary()!;
    expect(coordinator.beginOrdinary()).toBeNull();

    const stopEpoch = coordinator.beginStop()!;
    expect(stopEpoch).toBeGreaterThan(setupEpoch);
    expect(coordinator.beginStop()).toBeNull();

    const applied: string[] = [];
    let lateError: string | null = null;
    if (coordinator.isCurrent(setupEpoch)) {
      applied.push("late setup");
      lateError = "late setup error";
    }
    if (coordinator.isCurrent(stopEpoch)) applied.push("takeover");
    expect(applied).toEqual(["takeover"]);
    expect(lateError).toBeNull();

    coordinator.endStop();
    coordinator.endOrdinary();
    const refreshEpoch = coordinator.beginOrdinary()!;
    expect(coordinator.isCurrent(refreshEpoch)).toBe(true);
    expect(coordinator.isCurrent(setupEpoch)).toBe(false);
    coordinator.endOrdinary();
  });

  it("keeps ordinary actions serialized across takeover completion", () => {
    const coordinator = createComputerUseCommandCoordinator();
    const first = coordinator.beginOrdinary()!;
    coordinator.beginStop();
    coordinator.endStop();
    expect(coordinator.beginOrdinary()).toBeNull();
    expect(coordinator.isCurrent(first)).toBe(false);
    coordinator.endOrdinary();
    expect(coordinator.beginOrdinary()).not.toBeNull();
  });

  it("holds new ordinary actions until takeover completes", () => {
    const coordinator = createComputerUseCommandCoordinator();
    const stopEpoch = coordinator.beginStop()!;
    expect(coordinator.beginOrdinary()).toBeNull();
    expect(coordinator.isCurrent(stopEpoch)).toBe(true);
    coordinator.endStop();
    expect(coordinator.beginOrdinary()).not.toBeNull();
  });
});

describe("computerUseSetupSummary", () => {
  it("names only denied permissions without repeating the driver reason", () => {
    expect(
      computerUseSetupSummary({
        ...readyDriver,
        accessibility: "denied",
        reason: "macOS permission is missing.",
      }),
    ).toBe(
      "Allow Device Control and Data Access (Accessibility) in macOS Privacy & Security settings. Older macOS versions call this permission Accessibility.",
    );
    expect(computerUseSetupSummary({ ...readyDriver, reason: "Already handled." })).toBeNull();
  });

  it("distinguishes unknown permissions and omits granted ones", () => {
    expect(
      computerUseSetupSummary({
        ...readyDriver,
        screenRecording: "unknown",
      }),
    ).toBe(
      "Screen Recording has not been confirmed. Check macOS Privacy & Security settings, then refresh status.",
    );
  });

  it("uses the host's driver reason only when installation is incomplete", () => {
    expect(
      computerUseSetupSummary({
        ...readyDriver,
        installed: false,
        reason: "Install the SSHCode computer driver to continue.",
      }),
    ).toBe("Install the SSHCode computer driver to continue.");
  });

  it("reports an unsupported platform without asking for permissions", () => {
    expect(computerUseSetupSummary({ ...readyDriver, platform: "linux" }, false)).toBe(
      "Computer use is not supported on Linux.",
    );
  });
});

describe("computer use readiness", () => {
  it("requires installation and both OS permissions before reporting ready", () => {
    const missingDriver = makeStatus({ driver: { ...readyDriver, installed: false } });
    expect(computerUseReadiness(missingDriver)).toBe("driver-missing");
    expect(computerUseAvailabilityLabel(missingDriver)).toBe("Needs setup");

    const denied = makeStatus({ driver: { ...readyDriver, accessibility: "denied" } });
    expect(computerUseReadiness(denied)).toBe("permissions-denied");
    expect(computerUseAvailabilityLabel(denied)).toBe("Permissions needed");

    const unknown = makeStatus({ driver: { ...readyDriver, screenRecording: "unknown" } });
    expect(computerUseReadiness(unknown)).toBe("permissions-unknown");
    expect(computerUseAvailabilityLabel(unknown)).toBe("Permissions unknown");
    expect(computerUseAvailabilityLabel(makeStatus())).toBe("Ready");
    expect(computerUseAvailabilityLabel(makeStatus({ supported: false }))).toBe("Not supported");
  });
});

describe("computerUseChatStatus", () => {
  const threadId = ThreadId.make("thread-current");
  const otherThreadId = ThreadId.make("thread-other");
  const owner = {
    threadId: otherThreadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    appId: "com.apple.Safari",
    acquiredAt: 1,
  };
  const missingDriver = { ...readyDriver, installed: false };

  it("preserves controlling, queued, and busy priority over incomplete setup", () => {
    expect(
      computerUseChatStatus(
        makeStatus({ driver: missingDriver, owner: { ...owner, threadId } }),
        threadId,
      )?.kind,
    ).toBe("controlling");
    expect(
      computerUseChatStatus(
        makeStatus({ driver: missingDriver, owner, queued: [threadId] }),
        threadId,
      )?.kind,
    ).toBe("queued");
    expect(
      computerUseChatStatus(makeStatus({ driver: missingDriver, owner }), threadId)?.kind,
    ).toBe("busy");
  });

  it("prioritizes takeover and hides only disabled hosts", () => {
    expect(
      computerUseChatStatus(makeStatus({ driver: missingDriver, owner, paused: true }), threadId)
        ?.kind,
    ).toBe("paused");
    expect(computerUseChatStatus(makeStatus({ enabled: false }), threadId)).toBeNull();
    expect(computerUseControllerSummary(makeStatus({ paused: true }))).toBe("Agent access paused");
  });

  it("reports setup and permission state instead of a false ready status", () => {
    expect(computerUseChatStatus(makeStatus({ driver: missingDriver }), threadId)).toMatchObject({
      kind: "needs-setup",
      label: "Computer needs setup",
    });
    expect(
      computerUseChatStatus(
        makeStatus({ driver: { ...readyDriver, accessibility: "denied" } }),
        threadId,
      ),
    ).toMatchObject({ kind: "needs-setup", label: "Computer permissions needed" });
    expect(
      computerUseChatStatus(
        makeStatus({ driver: { ...readyDriver, screenRecording: "unknown" } }),
        threadId,
      ),
    ).toMatchObject({ kind: "setup-unknown", label: "Computer permissions unknown" });
    expect(computerUseChatStatus(makeStatus({ supported: false }), threadId)).toMatchObject({
      kind: "unavailable",
      label: "Computer unsupported",
    });
    expect(computerUseChatStatus(makeStatus(), threadId)?.kind).toBe("ready");
  });

  it("summarizes the active thread, app, and queue", () => {
    expect(computerUseControllerSummary(makeStatus({ owner, queued: [threadId] }))).toBe(
      "Thread thread-other · com.apple.Safari · 1 thread queued",
    );
    expect(computerUseControllerSummary(makeStatus())).toBe("No active controller");
  });
});
