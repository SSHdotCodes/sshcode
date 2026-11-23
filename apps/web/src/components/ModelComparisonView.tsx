import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ModelComparison,
  type ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { sendComparisonFollowUp } from "@t3tools/client-runtime/state/model-comparison";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShells, useServerConfigs, useThreadProjection } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useEnvironmentScope } from "../state/session";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { buildThreadRouteParams } from "../threadRoutes";
import { newMessageId } from "../lib/utils";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../lib/contextWindow";
import { formatContextWindowCost } from "./chat/ContextWindowMeter.logic";
import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import ChatView from "./ChatView";
import { comparisonModelPresentation } from "./ModelComparisonView.logic";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { Badge } from "./ui/badge";
import { TraitsSpeedIcon } from "./chat/TraitsSpeed";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

function ComparisonModelLabel({
  provider,
  selection,
  environmentId,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider | undefined;
  selection: ModelSelection;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const display = useMemo(
    () => comparisonModelPresentation({ provider, selection, settings }),
    [provider, selection, settings],
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="truncate font-medium">{display.name}</span>
      {display.traits?.label && provider ? (
        <Badge variant="outline" size="sm" aria-label={display.traits.label}>
          {display.traits.beforeSpeed}
          {display.traits.speedIcon ? (
            <TraitsSpeedIcon
              provider={provider.driver}
              speedIcon={display.traits.speedIcon}
              size="xs"
            />
          ) : null}
          {display.traits.afterSpeed}
        </Badge>
      ) : null}
    </div>
  );
}

function MemberStatus({ thread }: { thread: EnvironmentThreadShell }) {
  const projection = useThreadProjection(scopeThreadRef(thread.environmentId, thread.id));
  const usage = useMemo(() => {
    const detail = projection?.projection;
    if (!detail) return null;
    const activeProviderThread = detail.providerThreads.find(
      (providerThread) => providerThread.id === detail.thread.activeProviderThreadId,
    );
    return deriveLatestContextWindowSnapshot(
      detail.visibleTurnItems,
      latestProviderTurnTokenUsage(detail.providerTurns, activeProviderThread),
      activeProviderThread,
    );
  }, [projection]);
  const run = thread.latestRun;
  const working =
    run !== null && ["preparing", "starting", "running", "waiting", "queued"].includes(run.status);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working]);
  const start = run?.startedAt ?? run?.requestedAt;
  const elapsed = start
    ? Math.max(
        0,
        Math.floor(
          ((run?.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(start)) / 1_000,
        ),
      )
    : null;
  const status =
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest
      ? "Needs you"
      : thread.runtime?.status && thread.runtime.status !== "idle"
        ? thread.runtime.status
        : (run?.status ?? "Ready");
  return (
    <span>
      {status}
      {usage ? ` · ${usage.usedTokens.toLocaleString()} tokens` : ""}
      {usage?.cost ? ` · ${formatContextWindowCost(usage.cost)}` : ""}
      {elapsed === null ? "" : ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
    </span>
  );
}

/** Normal chat surfaces keep approvals, questions, media and live work identical to a single chat. */
export function ModelComparisonView({
  environmentId,
  comparison,
}: {
  environmentId: EnvironmentId;
  comparison: ModelComparison;
}) {
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const members = comparison.threadIds.flatMap((id) => {
    const thread = threads.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === id,
    );
    return thread && thread.deletedAt === null && thread.archivedAt === null ? [thread] : [];
  });
  const navigate = useNavigate();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const update = useAtomCommand(serverEnvironment.chatTabsCommand, { reportFailure: false });
  const send = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const draftTarget = DraftId.make(`comparison:${environmentId}:${comparison.id}`);
  const prompt = useComposerDraftStore(
    (store) => store.getComposerDraft(draftTarget)?.prompt ?? "",
  );
  const writePrompt = useComposerDraftStore((store) => store.setPrompt);
  const setPrompt = (text: string) => writePrompt(draftTarget, text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryIds, setRetryIds] = useState<ReadonlyArray<ThreadId> | null>(null);
  const followUpBatch = useRef(
    new Map<ThreadId, { messageId: ReturnType<typeof newMessageId>; createdAt: string }>(),
  );
  const submit = async () => {
    if (busy || !canOperate || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    const targets = retryIds ? members.filter((member) => retryIds.includes(member.id)) : members;
    if (retryIds === null) {
      const createdAt = new Date().toISOString();
      followUpBatch.current = new Map(
        targets.map((member) => [member.id, { messageId: newMessageId(), createdAt }]),
      );
    }
    const results = await sendComparisonFollowUp(targets, async (member) => {
      const submission = followUpBatch.current.get(member.id)!;
      const result = await send({
        environmentId,
        input: {
          threadId: member.id,
          commandId: CommandId.make(`compare-follow-up:${submission.messageId}`),
          message: {
            messageId: submission.messageId,
            role: "user",
            text: prompt.trim(),
            attachments: [],
          },
          modelSelection: member.modelSelection,
          runtimeMode: member.runtimeMode,
          interactionMode: member.interactionMode,
          dispatchMode: "queue",
          createdAt: submission.createdAt,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    });
    const failed = results.filter((result) => result.error !== null);
    setRetryIds(failed.length ? failed.map((result) => result.member.id) : null);
    if (failed.length)
      setError(
        failed.map((result) => `${result.member.modelSelection.model}: ${result.error}`).join("\n"),
      );
    else setPrompt("");
    setBusy(false);
  };
  const continueWith = async (threadId: ThreadId) => {
    if (busy || !canOperate) return;
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { action: "continue-comparison", comparisonId: comparison.id, threadId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not continue with this chat.");
      return;
    }
    if (prompt.trim()) {
      const target = scopeThreadRef(environmentId, threadId);
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(target)?.prompt ?? "";
      store.setPrompt(target, [existing, prompt].filter((text) => text.length > 0).join("\n\n"));
      setPrompt("");
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-model-comparison={comparison.id}
    >
      <WorkspacePageHeader electron={isElectron} className="border-b text-sm font-medium">
        <span className="truncate">Compare: {comparison.title}</span>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 snap-x overflow-x-auto">
        {members.map((member) => {
          const provider = configs
            .get(environmentId)
            ?.providers.find((entry) => entry.instanceId === member.modelSelection.instanceId);
          const harness = provider
            ? (PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver)
            : member.modelSelection.instanceId;
          const instance = provider ? resolveProviderInstanceDisplayName(provider) : harness;
          return (
            <section
              key={member.id}
              data-comparison-member={member.id}
              tabIndex={0}
              aria-label={member.modelSelection.model}
              className="flex min-h-0 min-w-[min(100%,24rem)] flex-1 snap-start flex-col border-r last:border-r-0"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <div className="min-w-0 text-xs">
                  <ComparisonModelLabel
                    environmentId={environmentId}
                    provider={provider}
                    selection={member.modelSelection}
                  />
                  <div className="text-muted-foreground">
                    {instance === harness ? harness : `${harness} · ${instance}`} ·{" "}
                    <MemberStatus thread={member} />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canOperate}
                  onClick={() => void continueWith(member.id)}
                >
                  Continue with this
                </Button>
              </div>
              <ChatView
                environmentId={environmentId}
                threadId={member.id}
                routeKind="server"
                comparisonColumn
                reserveTitleBarControlInset={false}
              />
            </section>
          );
        })}
      </div>
      <form
        className="flex shrink-0 flex-col gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          aria-label="Follow up with all models"
          placeholder="Follow up with all models…"
          value={prompt}
          disabled={busy || !canOperate}
          onChange={(event) => {
            setPrompt(event.target.value);
            setRetryIds(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Continuing keeps the other chats in Settled. You can reopen them anytime.</span>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !canOperate || !prompt.trim() || members.length === 0}
          >
            {busy ? "Working…" : retryIds ? `Retry ${retryIds.length}` : "Send to all"}
          </Button>
        </div>
      </form>
    </div>
  );
}
