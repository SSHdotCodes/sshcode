import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentRowPresentation, subagentStopTarget } from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: "Audit the timestamps",
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it.each([
    ["pending", "Queued"],
    ["running", "Running"],
    ["waiting", "Waiting"],
    ["idle", "Idle · resumable"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["cancelled", "Stopped"],
    ["interrupted", "Stopped"],
  ] as const)("uses the Mac card's wording for %s", (status, label) => {
    expect(resolveSubagentRowPresentation({ ...base, status }).statusLabel).toBe(label);
  });

  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: "Reading files",
      result: "stale result",
    });

    expect(row.detail).toBe("Reading files");
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("shows connection state for cached active work without hiding terminal results", () => {
    expect(
      resolveSubagentRowPresentation({ ...base, progress: "Reading" }, "reconnecting"),
    ).toMatchObject({ statusLabel: "Reconnecting", detail: null, tone: "stopped", live: false });
    expect(
      resolveSubagentRowPresentation({ ...base, status: "failed", result: "Failed" }, "offline"),
    ).toMatchObject({ statusLabel: "Failed", detail: "Failed", tone: "failed" });
    expect(resolveSubagentRowPresentation(base, "connected").statusLabel).toBe("Running");
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: "Reading files",
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe("Found two problems");
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe("Completed");
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "failed", result: "Timed out" });

    expect(row.detail).toBe("Timed out");
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({ ...base, title: "Subagent: /root/my_worker" });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe("My Worker");
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe("Queued");
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe("Failed");
  });
});

describe("subagentStopTarget", () => {
  const env = "local" as never;
  const running = {
    origin: "app_owned" as const,
    childThreadId: "thread-child" as never,
    startedAt: "2026-11-08T11:00:00.000Z" as never,
    status: "running" as const,
  };

  it("stops a started app-owned task through its child thread, on its own machine", () => {
    expect(subagentStopTarget(running, env)).toEqual({
      environmentId: env,
      threadId: "thread-child",
    });
    expect(
      subagentStopTarget({ ...running, remote: { environmentId: "studio" as never } }, env),
    ).toEqual({ environmentId: "studio", threadId: "thread-child" });
  });

  it("offers no stop for settled, unstarted or provider-native tasks", () => {
    expect(subagentStopTarget({ ...running, status: "completed" }, env)).toBeNull();
    expect(subagentStopTarget({ ...running, status: "idle" }, env)).toBeNull();
    expect(subagentStopTarget({ ...running, startedAt: null }, env)).toBeNull();
    expect(subagentStopTarget({ ...running, origin: "provider_native" }, env)).toBeNull();
    expect(subagentStopTarget({ ...running, childThreadId: null }, env)).toBeNull();
  });
});
