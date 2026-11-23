import { OVERVIEW_SUGGESTIONS, type OverviewEntry } from "@t3tools/client-runtime/overview";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";

import { OverviewComposer } from "../components/OverviewComposer";
import ChatMarkdown from "../components/ChatMarkdown";
import { HarnessMascot } from "../components/HarnessMascot";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useOverview, useOverviewEnabled } from "../hooks/useOverview";
import { usePrimaryEnvironmentId } from "../state/environments";

const OVERVIEW_DRIVER = "claudeAgent";

function Shimmer({ children }: { children: ReactNode }) {
  return (
    <span className="relative overflow-hidden whitespace-nowrap">
      {children}
      <span
        aria-hidden
        className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
      >
        <span className="live-activity-focus-counter block">
          <span className="live-activity-focus-aligned block text-foreground">{children}</span>
        </span>
      </span>
    </span>
  );
}

function OverviewMessage({
  entry,
  threadRef,
}: {
  entry: OverviewEntry;
  threadRef: ScopedThreadRef | undefined;
}) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm">
          <ChatMarkdown
            text={entry.text}
            cwd={undefined}
            threadRef={threadRef}
            lineBreaks
            parseRawHtml={false}
          />
        </div>
      </div>
    );
  }
  return (
    <div>
      <ChatMarkdown
        text={entry.text}
        cwd={undefined}
        threadRef={threadRef}
        isStreaming={entry.streaming}
      />
    </div>
  );
}

function OverviewConversation({
  environmentId,
  overview,
}: {
  environmentId: EnvironmentId;
  overview: ReturnType<typeof useOverview>;
}) {
  const { threadId, entries, working, error, send } = overview;
  const threadRef = threadId === null ? undefined : { environmentId, threadId };
  const scroller = useRef<HTMLDivElement>(null);
  const last = entries.at(-1);
  const answering = working && !(last?.role === "assistant" && last.streaming);

  // Follow the conversation as questions and answers arrive.
  useEffect(() => {
    const element = scroller.current;
    if (element && (entries.length > 0 || answering)) element.scrollTop = element.scrollHeight;
  }, [entries, answering]);

  return (
    <>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <HarnessMascot driver={OVERVIEW_DRIVER} state="greet" size={72} />
              <h2 className="text-lg font-medium">What would you like to know?</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                I can see all your chats and tell you what's going on. I only look; I never change
                anything.
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {OVERVIEW_SUGGESTIONS.map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="outline"
                    size="sm"
                    onClick={() => void send(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            entries.map((entry) => (
              <OverviewMessage key={entry.id} entry={entry} threadRef={threadRef} />
            ))
          )}
          {answering ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <HarnessMascot driver={OVERVIEW_DRIVER} state="working" size={24} />
              <Shimmer>Looking…</Shimmer>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-6">
        <OverviewComposer
          key={environmentId}
          environmentId={environmentId}
          onSend={(text, context) => void send(text, context)}
          autoFocus={entries.length > 0}
        />
      </div>
    </>
  );
}

function OverviewPage() {
  const environmentId = usePrimaryEnvironmentId();
  const [enabled, setEnabled] = useOverviewEnabled();
  const overview = useOverview(enabled ? environmentId : null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <HarnessMascot driver={OVERVIEW_DRIVER} size={18} still />
        <h1 className="text-sm font-medium">Overview</h1>
        <Badge variant="secondary" size="sm">
          Prototype
        </Badge>
      </WorkspacePageHeader>
      {!enabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">Overview is turned off.</p>
          <Button variant="outline" size="sm" onClick={() => setEnabled(true)}>
            Turn it on
          </Button>
        </div>
      ) : environmentId === null ? (
        <p className="p-6 text-sm text-muted-foreground">
          Connect to your Mac to see what your chats are doing.
        </p>
      ) : (
        <OverviewConversation environmentId={environmentId} overview={overview} />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/overview")({ component: OverviewPage });
