import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeMonitorUpdates,
  monitorNotificationLabel,
  monitorNotificationParts,
  monitorUpdateContinues,
} from "./monitorNotification.ts";

type NotificationItem = Extract<OrchestrationV2TurnItem, { type: "notification" }>;

const description = "RL rollouts it1a-method: B5 with the hidden method on 59 tasks x2";

function notification(input: {
  readonly id: string;
  readonly event: string;
  readonly outcome?: NotificationItem["outcome"];
  readonly detail?: string;
  readonly runId?: string;
  readonly kind?: "monitor" | "background_task";
  readonly summary?: string;
}): NotificationItem {
  return {
    id: input.id,
    type: "notification",
    runId: input.runId ?? "run-1",
    source: { kind: input.kind ?? "monitor" },
    outcome: input.outcome ?? "updated",
    summary: input.summary ?? `${description}: ${input.event}`,
    detail: input.detail,
    ordinal: Number(input.id.replace(/\D/g, "")),
    startedAt: `2026-11-12T18:49:0${input.id.replace(/\D/g, "")}.000Z`,
  } as unknown as NotificationItem;
}

describe("monitorNotificationLabel", () => {
  it("keeps a description that has colons of its own in one piece", () => {
    expect(monitorNotificationParts(notification({ id: "n1", event: "output" }))).toEqual({
      description,
      event: "output",
    });
    expect(
      monitorNotificationParts(
        notification({ id: "n1", event: "stopped: output rate limit exceeded" }),
      ),
    ).toEqual({ description, event: "stopped: output rate limit exceeded" });
  });

  it("drops the word that says nothing from a single output report", () => {
    expect(monitorNotificationLabel(notification({ id: "n1", event: "output" }))).toBe(description);
  });

  it("leads with what happened, which a cut-off row would otherwise hide", () => {
    expect(
      monitorNotificationLabel(
        notification({ id: "n1", event: "exited with code 1", outcome: "failed" }),
      ),
    ).toBe(`Exited with code 1 · ${description}`);
    expect(
      monitorNotificationLabel(
        notification({ id: "n1", event: "exited with code 0", outcome: "completed" }),
      ),
    ).toBe(`Finished · ${description}`);
    expect(monitorNotificationLabel(notification({ id: "n1", event: "no output for 10m" }))).toBe(
      `No output for 10m · ${description}`,
    );
    expect(monitorNotificationLabel(notification({ id: "n1", event: "output" }), 5)).toBe(
      `5 updates · ${description}`,
    );
  });

  it("leaves other notifications and unknown wording as they are", () => {
    expect(
      monitorNotificationLabel(
        notification({ id: "n1", event: "output", kind: "background_task" }),
      ),
    ).toBe(`${description}: output`);
    expect(
      monitorNotificationLabel(notification({ id: "n1", event: "", summary: "Build finished" })),
    ).toBe("Build finished");
  });
});

describe("monitorUpdateContinues", () => {
  const first = notification({ id: "n1", event: "output" });

  it("joins output reports from the same monitor in the same run", () => {
    expect(monitorUpdateContinues(first, notification({ id: "n2", event: "output" }))).toBe(true);
  });

  it("keeps an exit, another monitor and another run apart", () => {
    expect(
      monitorUpdateContinues(
        first,
        notification({ id: "n2", event: "exited with code 1", outcome: "failed" }),
      ),
    ).toBe(false);
    expect(
      monitorUpdateContinues(
        first,
        notification({ id: "n2", event: "output", summary: "Other monitor: output" }),
      ),
    ).toBe(false);
    expect(
      monitorUpdateContinues(first, notification({ id: "n2", event: "output", runId: "run-2" })),
    ).toBe(false);
    expect(
      monitorUpdateContinues(
        notification({ id: "n1", event: "no output for 10m" }),
        notification({ id: "n2", event: "no output for 10m" }),
      ),
    ).toBe(false);
  });
});

describe("mergeMonitorUpdates", () => {
  it("keeps the first report's identity and every report's output, in order", () => {
    const merged = mergeMonitorUpdates([
      notification({ id: "n1", event: "output", detail: "worker espocrm-020 failed" }),
      notification({ id: "n2", event: "output", detail: "  " }),
      notification({ id: "n3", event: "output", detail: "worker erpnext-007 failed\n" }),
    ]);
    expect(merged.id).toBe("n1");
    expect(merged.ordinal).toBe(1);
    expect(merged.summary).toBe(`3 updates · ${description}`);
    expect(merged.detail).toBe("worker espocrm-020 failed\nworker erpnext-007 failed");
    // The merged summary is final: reading it as a label again changes nothing.
    expect(monitorNotificationLabel(merged)).toBe(merged.summary);
  });

  it("returns a lone report untouched", () => {
    const only = notification({ id: "n1", event: "output", detail: "line" });
    expect(mergeMonitorUpdates([only])).toBe(only);
  });
});
