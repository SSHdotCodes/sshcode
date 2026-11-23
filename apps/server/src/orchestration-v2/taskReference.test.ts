import { describe, expect, it } from "vite-plus/test";
import { NodeId } from "@t3tools/contracts";
import { resolveTaskReference, taskReference, withTaskReference } from "./taskReference.ts";

const canonical = (session: string, request = "review") =>
  NodeId.make(
    `node:delegated-task:${encodeURIComponent(`command:mcp:${session}:delegate-task:${encodeURIComponent(request)}`)}`,
  );

describe("task references", () => {
  it("keeps handles stable, short and distinct when request ids repeat", () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => ({
      id: canonical(`session-${index}`),
    }));
    const handles = tasks.map(({ id }) => taskReference(id));
    expect(new Set(handles).size).toBe(tasks.length);
    for (const task of tasks) {
      const handle = taskReference(task.id);
      expect(handle.length).toBeLessThanOrEqual(16);
      expect(taskReference(task.id)).toBe(handle);
      expect(resolveTaskReference(tasks, handle)).toBe(task);
      expect(resolveTaskReference(tasks, task.id)).toBe(task);
    }
    expect(resolveTaskReference(tasks, "review")).toBeUndefined();
  });

  it("resolves only unambiguous client request ids in the caller's tasks", () => {
    const task = { id: canonical("session-a", "review:1 / fixes") };
    expect(resolveTaskReference([task], "review:1 / fixes")).toBe(task);
    expect(resolveTaskReference([], taskReference(task.id))).toBeUndefined();
    expect(
      resolveTaskReference(
        [task, { id: canonical("session-b", "review:1 / fixes") }],
        "review:1 / fixes",
      ),
    ).toBeUndefined();
    expect(taskReference("old-task")).toBe("old-task");
  });

  it("keeps a returned handle usable when another request uses it as a client id", () => {
    const task = { id: canonical("session-a") };
    const handle = taskReference(task.id);
    expect(resolveTaskReference([task, { id: canonical("session-b", handle) }], handle)).toBe(task);
  });

  it("distinguishes encoded request keys from their literal spellings", () => {
    const slash = { id: canonical("session-a", "/") };
    const percent = { id: canonical("session-b", "%2F") };
    expect(resolveTaskReference([slash, percent], "/")).toBe(slash);
    expect(resolveTaskReference([slash, percent], "%2F")).toBe(percent);
    expect(resolveTaskReference([slash], "%2F")).toBeUndefined();
  });

  it("saves four id repetitions in a delegate, status, grade cycle", () => {
    const taskId = canonical("provider-session-9b46c742-6ea4-4d40-a4dc-6db7f2c4b0a1");
    const cycle = (id: string) =>
      JSON.stringify({
        delegate: { taskId: id },
        statusInput: { taskId: id },
        statusOutput: { taskId: id },
        sendInput: { threadId: "child", grades: [{ taskId: id, score: 10 }] },
      });
    const saved = cycle(taskId).length - cycle(taskReference(taskId)).length;
    expect(saved).toBe(4 * (taskId.length - 16));
    expect(taskId.length).toBe(114);
    expect(saved).toBe(392);
    expect(withTaskReference({ taskId, childThreadId: "child" })).toEqual({
      taskId: taskReference(taskId),
      childThreadId: "child",
    });
  });
});
