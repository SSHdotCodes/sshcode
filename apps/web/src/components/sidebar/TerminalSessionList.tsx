import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { useSidebar } from "../ui/sidebar";

import { Button } from "../ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { claudeRcEnvironment } from "../../state/claudeRc";
import {
  TERMINAL_SESSION_LABEL,
  filterTerminalSessions,
  terminalHostPhase,
  terminalSessionRelativeTime,
} from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionList(props: {
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly query: string;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly configLoaded: boolean;
  readonly claudeRemoteControl: boolean | undefined;
  readonly starting?: boolean;
}) {
  const host = terminalHostPhase(props);
  if (host.phase !== "ready" || props.environmentId === null) {
    return (
      <p
        role={host.phase === "unsupported" ? "alert" : "status"}
        className="px-2.5 py-2 text-xs text-muted-foreground"
      >
        {host.message ?? "Looking for sessions…"}
      </p>
    );
  }
  return (
    <ReadyTerminalSessions
      environmentId={props.environmentId}
      label={props.label}
      query={props.query}
    />
  );
}

function ReadyTerminalSessions(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly query: string;
}) {
  const params = useParams({ strict: false });
  const { setOpenMobile } = useSidebar();
  const sessionsQuery = useEnvironmentQuery(
    claudeRcEnvironment.sessions({ environmentId: props.environmentId, input: {} }),
  );
  const sessions = filterTerminalSessions(sessionsQuery.data ?? [], props.query);
  const loading = sessionsQuery.data === null && sessionsQuery.error === null;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <ul aria-label="Terminal sessions" className="flex flex-col gap-px">
        {sessions.map((session) => (
          <li key={session.id}>
            <Link
              to="/terminal/$environmentId/$sessionId"
              params={{ environmentId: props.environmentId, sessionId: session.id }}
              aria-current={
                params.environmentId === props.environmentId && params.sessionId === session.id
                  ? "page"
                  : undefined
              }
              className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-sidebar-row-hover"
              onClick={() => setOpenMobile(false)}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    {session.title || TERMINAL_SESSION_LABEL}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {terminalSessionRelativeTime(session.updatedAt)}
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {TERMINAL_SESSION_LABEL} · {props.label}
                </span>
                {session.working ? (
                  <span className="block text-2xs text-info-foreground">Working</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {loading ? (
        <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
          Looking for sessions…
        </p>
      ) : null}
      {sessionsQuery.error ? (
        <div>
          <p role="alert" className="px-2.5 text-xs text-destructive">
            {props.label}: {sessionsQuery.error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => sessionsQuery.refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {!loading && sessionsQuery.error === null && sessions.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">
          {props.query.trim().length > 0
            ? "No sessions match that search."
            : "No Claude Code sessions with Remote Control are running."}
        </p>
      ) : null}
    </div>
  );
}
