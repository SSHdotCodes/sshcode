import {
  type ComputerDriverStatus,
  type ComputerUseStatus,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createComputerUseAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const concurrency = {
    mode: "singleFlight" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer-use:state",
      tag: WS_METHODS.subscribeComputerUse,
      idleTtlMs: 0,
      resubscribeOnWakeup: true,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:refresh",
      tag: WS_METHODS.computerStatus,
      concurrency,
    }),
    setup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:setup",
      tag: WS_METHODS.computerSetup,
      concurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:stop",
      tag: WS_METHODS.computerStop,
      concurrency,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:resume",
      tag: WS_METHODS.computerResume,
      concurrency,
    }),
  };
}

export function parseBlockedAppIds(value: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(/[\n,]/u)) {
    const identifier = part.trim();
    if (identifier.length === 0 || seen.has(identifier)) continue;
    seen.add(identifier);
    identifiers.push(identifier);
  }
  return identifiers;
}

export function formatBlockedAppIds(identifiers: ReadonlyArray<string>): string {
  return identifiers.join("\n");
}

export function createComputerUseCommandCoordinator() {
  let ordinaryPending = false;
  let stopPending = false;
  let epoch = 0;
  return {
    beginOrdinary(): number | null {
      if (ordinaryPending || stopPending) return null;
      ordinaryPending = true;
      return epoch;
    },
    beginStop(): number | null {
      if (stopPending) return null;
      stopPending = true;
      epoch += 1;
      return epoch;
    },
    isCurrent(token: number): boolean {
      return token === epoch;
    },
    endOrdinary() {
      ordinaryPending = false;
    },
    endStop() {
      stopPending = false;
    },
  };
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

export type ComputerUseReadiness =
  | "unsupported"
  | "driver-missing"
  | "permissions-denied"
  | "permissions-unknown"
  | "ready";

export function computerUseReadiness(
  status: Pick<ComputerUseStatus, "supported" | "driver">,
): ComputerUseReadiness {
  if (!status.supported) return "unsupported";
  if (!status.driver.installed) return "driver-missing";
  if (status.driver.accessibility === "denied" || status.driver.screenRecording === "denied") {
    return "permissions-denied";
  }
  if (status.driver.accessibility === "unknown" || status.driver.screenRecording === "unknown") {
    return "permissions-unknown";
  }
  return "ready";
}

export function computerUseAvailabilityLabel(
  status: Pick<ComputerUseStatus, "supported" | "driver">,
): string {
  switch (computerUseReadiness(status)) {
    case "unsupported":
      return "Not supported";
    case "driver-missing":
      return "Needs setup";
    case "permissions-denied":
      return "Permissions needed";
    case "permissions-unknown":
      return "Permissions unknown";
    case "ready":
      return "Ready";
  }
}

export function computerUseSetupSummary(
  driver: ComputerDriverStatus,
  supported = true,
): string | null {
  if (!supported) return `Computer use is not supported on ${platformLabel(driver.platform)}.`;
  if (!driver.installed) {
    return (
      driver.reason ??
      `The computer-use driver for ${platformLabel(driver.platform)} needs to be installed.`
    );
  }
  const instructions: string[] = [];
  if (driver.accessibility === "denied") {
    instructions.push(
      "Allow Device Control and Data Access (Accessibility) in macOS Privacy & Security settings. Older macOS versions call this permission Accessibility.",
    );
  } else if (driver.accessibility === "unknown") {
    instructions.push(
      "Device Control and Data Access (Accessibility) has not been confirmed. Check macOS Privacy & Security settings, then refresh status. Older macOS versions call this permission Accessibility.",
    );
  }
  if (driver.screenRecording === "denied") {
    instructions.push("Allow Screen Recording in macOS Privacy & Security settings.");
  } else if (driver.screenRecording === "unknown") {
    instructions.push(
      "Screen Recording has not been confirmed. Check macOS Privacy & Security settings, then refresh status.",
    );
  }
  return instructions.length > 0 ? instructions.join(" ") : null;
}

export interface ComputerUseChatStatus {
  readonly kind:
    | "ready"
    | "controlling"
    | "queued"
    | "busy"
    | "paused"
    | "needs-setup"
    | "setup-unknown"
    | "unavailable";
  readonly label: string;
  readonly detail: string;
}

export function computerUseChatStatus(
  status: ComputerUseStatus,
  threadId: ThreadId,
): ComputerUseChatStatus | null {
  if (!status.enabled) return null;
  if (status.paused) {
    return {
      kind: "paused",
      label: "Computer paused",
      detail: "You have computer control. Agent input is stopped until you resume it.",
    };
  }
  if (status.owner?.threadId === threadId) {
    return {
      kind: "controlling",
      label: "Controlling computer",
      detail: `This thread is controlling ${status.owner.appId}.`,
    };
  }
  if (status.queued.includes(threadId)) {
    return {
      kind: "queued",
      label: "Computer queued",
      detail: status.owner
        ? `This thread is waiting for control from another thread using ${status.owner.appId}.`
        : "This thread is waiting for computer control.",
    };
  }
  if (status.owner) {
    return {
      kind: "busy",
      label: "Computer in use",
      detail: `Another thread is controlling ${status.owner.appId}.`,
    };
  }
  const readiness = computerUseReadiness(status);
  if (readiness !== "ready") {
    const detail = computerUseSetupSummary(status.driver, status.supported)!;
    switch (readiness) {
      case "unsupported":
        return { kind: "unavailable", label: "Computer unsupported", detail };
      case "driver-missing":
        return { kind: "needs-setup", label: "Computer needs setup", detail };
      case "permissions-denied":
        return { kind: "needs-setup", label: "Computer permissions needed", detail };
      case "permissions-unknown":
        return { kind: "setup-unknown", label: "Computer permissions unknown", detail };
    }
  }
  return {
    kind: "ready",
    label: "Computer ready",
    detail: "The driver and OS permissions are ready for agents on this environment.",
  };
}

export function computerUseControllerSummary(status: ComputerUseStatus): string {
  if (status.paused) {
    return status.owner
      ? `Agent access paused · Thread ${status.owner.threadId} · ${status.owner.appId}`
      : "Agent access paused";
  }
  if (status.owner) {
    const queued =
      status.queued.length > 0
        ? ` · ${status.queued.length} ${status.queued.length === 1 ? "thread" : "threads"} queued`
        : "";
    return `Thread ${status.owner.threadId} · ${status.owner.appId}${queued}`;
  }
  return status.queued.length > 0
    ? `${status.queued.length} ${status.queued.length === 1 ? "thread" : "threads"} queued`
    : "No active controller";
}
