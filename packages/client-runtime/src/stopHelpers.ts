import type {
  MonitorInfo,
  OrchestrationV2Subagent,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

/** The managed work that survives Stop reply, named briefly for the stop menu. */
export function describeThreadHelpers(input: {
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "status" | "childThreadId" | "title" | "prompt">
  >;
  readonly monitors: ReadonlyArray<Pick<MonitorInfo, "description">>;
  readonly pullRequests?: ReadonlyArray<Pick<ThreadPullRequestLink, "number" | "watch">>;
}): string | null {
  const names = [
    ...input.subagents
      .filter(
        (task) =>
          task.origin === "app_owned" &&
          task.childThreadId !== null &&
          (task.status === "pending" || task.status === "running" || task.status === "waiting"),
      )
      .map((task) => task.title || task.prompt || "Child task"),
    ...input.monitors.map((monitor) => monitor.description),
    ...(input.pullRequests ?? [])
      .filter((pr) => pr.watch !== undefined)
      .map((pr) => `PR #${pr.number}`),
  ];
  if (names.length === 0) return null;
  const brief = names
    .slice(0, 2)
    .map((name) => {
      const text = name.replace(/\s+/g, " ").trim();
      return text.length > 40 ? `${text.slice(0, 39)}…` : text;
    })
    .join(", ");
  return `Keeps ${names.length} ${names.length === 1 ? "subagent" : "subagents"} running: ${brief}${names.length > 2 ? `, +${names.length - 2} more` : ""}`;
}
