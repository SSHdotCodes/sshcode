const LABELS: Readonly<Record<string, string>> = {
  "app.entry": "JavaScript started",
  "app.launch": "App registered",
  "shell.preview": "First-screen cache ready",
  "shell.cached": "Full chat cache ready",
  "home.list.visible": "Chat list visible",
  "shell.live": "Chats synchronized",
  "chat.opened": "Chat opened",
  "chat.messages.ready": "Chat messages ready",
  "thread.start": "Chat load started",
  "thread.session.wait": "Waiting for session",
  "thread.session.available": "Session available",
  "thread.config.wait": "Waiting for server config",
  "thread.config.ready": "Server config ready",
  "thread.prepared.wait": "Waiting for HTTP connection",
  "thread.prepared.ready": "HTTP connection ready",
  "thread.http.start": "Chat snapshot started",
  "thread.http.fallback": "Full snapshot fallback started",
  "thread.http.restore": "Snapshot restored",
  "thread.http.applied": "Snapshot applied",
  "thread.subscribe": "Chat subscription prepared",
  "thread.stream.start": "Chat stream started",
  "thread.first": "First chat stream frame",
  "thread.cached": "Chat cache checked",
  "thread.http": "Chat snapshot",
  "thread.applied": "Chat data applied",
  "thread.live": "Chat stream synchronized",
  "ui.thread.syncing": "Chat syncing",
  "ui.thread.synced": "Chat synced",
  "session.ready": "Session ready",
  "connect.probe.started": "Connection check started",
  "connect.probe.finished": "Connection check finished",
};

/** Latest launch only; malformed diagnostic lines never hide the others. */
export function loadingTimingLines(text: string): string[] {
  let result: string[] = [];
  let launchedAt: number | undefined;
  let openedAt: number | undefined;
  const threadOpens = new Map<string, number>();
  let awaitingRegistration = false;
  for (const line of text.split("\n")) {
    try {
      const mark: unknown = JSON.parse(line);
      if (typeof mark !== "object" || mark === null || !("name" in mark) || !("atMs" in mark))
        continue;
      if (
        typeof mark.name !== "string" ||
        typeof mark.atMs !== "number" ||
        !Number.isFinite(mark.atMs)
      )
        continue;
      if (mark.name === "app.entry" || (mark.name === "app.launch" && !awaitingRegistration)) {
        result = [];
        launchedAt = mark.atMs;
        openedAt = undefined;
        threadOpens.clear();
      }
      if (mark.name === "app.entry") awaitingRegistration = true;
      if (mark.name === "app.launch") awaitingRegistration = false;
      const thread = "thread" in mark && typeof mark.thread === "string" ? mark.thread : undefined;
      const environment =
        "environment" in mark && typeof mark.environment === "string" ? mark.environment : "";
      const openKey = thread === undefined ? undefined : `${environment}:${thread}`;
      if (mark.name === "chat.opened") {
        openedAt = mark.atMs;
        if (openKey !== undefined) threadOpens.set(openKey, mark.atMs);
      }
      const label = LABELS[mark.name];
      if (label && launchedAt !== undefined) {
        const details = [
          "environment",
          "thread",
          "load",
          "attempt",
          "outcome",
          "found",
          "ms",
          "budgetMs",
          "reason",
          "items",
          "snapshot",
          "retained",
          "resume",
          "sequence",
          "completionMarker",
          "kind",
        ].flatMap((key) =>
          key in mark &&
          ["string", "number", "boolean"].includes(typeof mark[key as keyof typeof mark])
            ? [`${key}=${String(mark[key as keyof typeof mark])}`]
            : [],
        );
        const matchingOpen = openKey === undefined ? undefined : threadOpens.get(openKey);
        const relativeOpen =
          matchingOpen ??
          (thread === undefined && mark.name === "chat.messages.ready" ? openedAt : undefined);
        const sinceOpen =
          relativeOpen !== undefined && mark.name !== "chat.opened"
            ? `, open +${Math.round(mark.atMs - relativeOpen)} ms`
            : "";
        result.push(
          `${label}: ${Math.round(mark.atMs - launchedAt)} ms${sinceOpen}${details.length ? ` (${details.join(", ")})` : ""}`,
        );
      }
    } catch {
      // An interrupted final line can be followed by valid lines next launch.
    }
  }
  return result.slice(-100);
}
