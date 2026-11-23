import {
  EventId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { compactThreadReplay } from "./ThreadStream.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

type ReplayEvent = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
function event(
  type: OrchestrationV2DomainEvent["type"],
  payload: object,
  sequence: number,
): ReplayEvent {
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`e-${sequence}`),
      threadId: v2Projection.thread.id,
      occurredAt: DateTime.makeUnsafe(sequence * 1000),
      type,
      payload,
    } as OrchestrationV2DomainEvent,
  };
}
function item(id: string, ordinal: number, extra: object = {}) {
  return {
    id: TurnItemId.make(id),
    threadId: v2Projection.thread.id,
    type: "command_execution",
    ordinal,
    runId: null,
    nodeId: null,
    input: "echo hi",
    status: "running",
    ...extra,
  };
}
function fold(
  projection: typeof v2Projection,
  events: ReadonlyArray<ReplayEvent>,
  partial = false,
) {
  let result = projection;
  let watermark = Math.max(0, ...projection.turnItems.map((item) => item.ordinal));
  for (const { event } of events) {
    result = applyOrchestrationV2ProjectionEvent(
      result,
      event,
      partial ? { partialTimeline: true, latestLocalTurnOrdinal: watermark } : undefined,
    )!;
    if (event.type === "turn-item.updated") watermark = Math.max(watermark, event.payload.ordinal);
  }
  return result;
}
function assertEveryCursor(events: ReadonlyArray<ReplayEvent>) {
  for (let cursor = 0; cursor <= events.length; cursor++) {
    const prefix = fold(v2Projection, events.slice(0, cursor));
    const replay = events.slice(cursor);
    const compacted = compactThreadReplay(replay);
    expect(fold(prefix, compacted), `cursor ${cursor}`).toEqual(fold(prefix, replay));
    const bounded = {
      ...prefix,
      turnItems: prefix.turnItems.slice(-1),
      visibleTurnItems: prefix.visibleTurnItems.slice(-1),
    };
    expect(fold(bounded, compacted, true), `partial cursor ${cursor}`).toEqual(
      fold(bounded, replay, true),
    );
    expect(compacted.map((item) => item.sequence)).toEqual(
      compacted.map((item) => item.sequence).toSorted((a, b) => a - b),
    );
  }
}

describe("compacted thread replay", () => {
  it.each([
    "node.updated",
    "subagent.updated",
    "provider-session.updated",
    "provider-thread.updated",
    "runtime-request.updated",
    "message.updated",
    "plan.updated",
    "context-handoff.updated",
    "context-transfer.updated",
  ] as const)("preserves first insertion order and last full state for %s", (type) => {
    const events = [
      event(type, { id: "a", value: 0 }, 1),
      event(type, { id: "b", value: 1 }, 2),
      event(type, { id: "a", value: 2 }, 3),
      event(type, { id: "a", value: 3 }, 4),
    ];
    expect(compactThreadReplay(events).map((item) => item.sequence)).toEqual([1, 2, 4]);
    assertEveryCursor(events);
  });
  it("retains explicit provider token usage when later states omit it", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(
        "provider-turn.updated",
        {
          id: index === 1 ? "b" : "a",
          status: `state-${index}`,
          ...([2, 3, 8].includes(index) ? { tokenUsage: { inputTokens: index } } : {}),
        },
        index + 1,
      ),
    );
    expect(compactThreadReplay(events).length).toBeLessThan(events.length);
    assertEveryCursor(events);
  });
  it("compacts interleaved items while retaining structural and visibility barriers", () => {
    let sequence = 0;
    const events: ReplayEvent[] = [];
    const push = (type: OrchestrationV2DomainEvent["type"], payload: object) =>
      events.push(event(type, payload, ++sequence));
    push("run.created", { id: "run", status: "running" });
    for (let index = 0; index < 8; index++) {
      push("turn-item.updated", item("a", 10, { output: `output-${index}` }));
      push("provider-turn.updated", { id: "provider-turn", status: "running" });
      push("turn-item.updated", item("b", 20, { output: `output-${index}` }));
      push("node.updated", { id: "node", status: `status-${index}` });
    }
    push("turn-item.updated", item("a", 30));
    push("run.updated", { id: "run", status: "rolled_back" });
    push("turn-item.updated", item("a", 30, { runId: "run" }));
    push("run.updated", { id: "run", status: "running" });
    push("turn-item.updated", item("a", 30, { runId: "run" }));
    push("run-attempt.updated", {
      id: "attempt",
      runId: "run",
      rootNodeId: "root",
      status: "superseded",
    });
    push(
      "turn-item.updated",
      item("result", 40, { type: "run_interrupt_result", runId: "run", nodeId: "root" }),
    );
    push("turn-item.updated", item("request", 41, { type: "run_interrupt_request", runId: "run" }));
    push(
      "turn-item.updated",
      item("result", 40, { type: "run_interrupt_result", runId: "run", nodeId: "root" }),
    );
    expect(compactThreadReplay(events).length).toBeLessThan(events.length / 2);
    assertEveryCursor(events);
    assertEveryCursor(
      events.map((item) => ({ ...item, event: projectDomainEventForWire(item.event) })),
    );
  });
  it("keeps both sides of an interrupt request changing back to its prior item type", () => {
    const events = [
      event("turn-item.updated", item("request", 1), 1),
      event("turn-item.updated", item("request", 1, { type: "run_interrupt_request" }), 2),
      ...[3, 4, 5].map((sequence) => event("turn-item.updated", item("result", 2), sequence)),
      event("turn-item.updated", item("request", 1), 6),
      ...[7, 8, 9].map((sequence) => event("turn-item.updated", item("result", 2), sequence)),
    ];
    expect(compactThreadReplay(events).map((item) => item.sequence)).toEqual([1, 2, 3, 5, 6, 7, 9]);
    assertEveryCursor(events);
  });

  it("does not cross detach/reattach, creates, patches, or read-state events", () => {
    const events = [
      event("provider-session.updated", { id: "session", value: 1 }, 1),
      event("provider-session.updated", { id: "session", value: 2 }, 2),
      event("provider-session.detached", { providerSessionId: "session" }, 3),
      event("provider-session.attached", { id: "session", value: 3 }, 4),
      event("provider-session.updated", { id: "session", value: 4 }, 5),
      event("thread.visited", { ...v2Projection.thread }, 6),
      event(
        "run.background-work-cancelled",
        { runId: "run", restartCancelledBackgroundWork: false },
        7,
      ),
      event("checkpoint.rollback-requested", {}, 8),
    ];
    expect(compactThreadReplay(events)).toEqual(events);
    assertEveryCursor(events);
  });
});
