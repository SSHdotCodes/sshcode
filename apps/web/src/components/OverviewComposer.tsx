import { useQuestComposer } from "../questBridge";
import {
  chatMentionSearchQuery,
  matchComposerThreadItems,
  rankComposerChatMentions,
} from "@t3tools/client-runtime/composerThreadItems";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  isHelperThreadId,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { collapseExpandedComposerCursor, detectComposerTrigger } from "../composer-logic";
import { useThreadSearch } from "../state/queries";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useTheme } from "../hooks/useTheme";
import { insertOverviewChatMention, overviewMessageContext } from "../lib/overviewComposer";
import { useThreadShells } from "../state/entities";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { composerContextRecordsFromDraft } from "./composerContextPresentation";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./chat/ComposerCommandMenu";
import { useComposerTriggerState } from "./chat/useComposerTriggerState";
import { Button } from "./ui/button";

export function OverviewComposer(props: {
  environmentId: EnvironmentId;
  onSend: (text: string, context?: OrchestrationMessageContext) => void;
  autoFocus: boolean;
}) {
  const [draft, setDraft] = useState({ text: "", cursor: 0 });
  const [threads, setThreads] = useState<ThreadContextRecord[]>([]);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const { trigger, setTrigger, resetTrigger, dismissTrigger, resolveTrigger } =
    useComposerTriggerState(() => null);
  const [highlight, setHighlight] = useState<{ query: string; id: string | null }>({
    query: "",
    id: null,
  });
  const listId = `${useId()}-overview-chats`;
  // `@name` and `@[a description with spaces]` both pick a chat here.
  const mentioning = trigger?.kind === "path" || trigger?.kind === "chat";
  const describing = trigger?.kind === "chat";
  const shells = useThreadShells(mentioning, trigger?.kind === "path");
  const { resolvedTheme } = useTheme();
  const describedEnvironments = useMemo(
    () => (describing ? [props.environmentId] : []),
    [describing, props.environmentId],
  );
  const described = useThreadSearch(
    describedEnvironments,
    trigger?.kind === "chat" ? chatMentionSearchQuery(trigger.query) : "",
  );
  const items = useMemo(() => {
    if (trigger?.kind !== "path" && trigger?.kind !== "chat") return [];
    const candidates = shells.filter(
      (shell) => shell.environmentId === props.environmentId && !isHelperThreadId(shell.id),
    );
    if (trigger.kind === "chat") {
      return rankComposerChatMentions({
        shells: candidates,
        environmentId: props.environmentId,
        excludeThreadId: null,
        query: trigger.query,
        matches: described.matches,
        workingThreadIds: new Set(candidates.filter(isThreadWorking).map((shell) => shell.id)),
        limit: 20,
        age: formatRelativeTimeLabel,
      });
    }
    return matchComposerThreadItems({
      shells: candidates,
      environmentId: props.environmentId,
      excludeThreadId: null,
      query: trigger.query,
      allowEmptyQuery: true,
      workingThreadIds: new Set(candidates.filter(isThreadWorking).map((shell) => shell.id)),
      limit: 20,
    });
  }, [shells, props.environmentId, trigger, described.matches]);
  const activeItemId =
    highlight.query === trigger?.query && items.some((item) => item.id === highlight.id)
      ? highlight.id
      : (items[0]?.id ?? null);
  const contextRecords = useMemo(
    () => composerContextRecordsFromDraft({ terminalContexts: [], threadContexts: threads }),
    [threads],
  );

  useEffect(() => {
    if (props.autoFocus) editorRef.current?.focus();
  }, [props.autoFocus]);

  const send = () => {
    const text = editorRef.current?.readSnapshot().value ?? draft.text;
    if (text.trim().length === 0 || text.length > 4_000) return;
    props.onSend(text, overviewMessageContext(text, threads));
    setDraft({ text: "", cursor: 0 });
    setThreads([]);
    resetTrigger(null);
  };
  useQuestComposer({
    focusComposer: () => editorRef.current?.focus(),
    insertText: (text) => {
      const editor = editorRef.current;
      if (!editor) return;
      const snapshot = editor.readSnapshot();
      const { start, end } = editor.readSelectionRange();
      const value = snapshot.value.slice(0, start) + text + snapshot.value.slice(end);
      const expandedCursor = start + text.length;
      const cursor = collapseExpandedComposerCursor(value, expandedCursor);
      setDraft({ text: value, cursor });
      setTrigger(detectComposerTrigger(value, expandedCursor));
      requestAnimationFrame(() => editorRef.current?.focusAt(cursor));
    },
    send,
  });
  const select = (item: ComposerCommandItem) => {
    if (item.type !== "thread") return;
    const snapshot = editorRef.current?.readSnapshot();
    if (!snapshot) return;
    const currentTrigger = resolveTrigger(
      detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    );
    if (currentTrigger?.kind !== "path" && currentTrigger?.kind !== "chat") return;
    const next = insertOverviewChatMention(snapshot.value, currentTrigger, item.thread, item.label);
    const cursor = collapseExpandedComposerCursor(next.text, next.cursor);
    setThreads((previous) => [
      ...previous.filter((record) => record.contextId !== next.record.contextId),
      next.record,
    ]);
    setDraft({ text: next.text, cursor });
    resetTrigger(null);
    requestAnimationFrame(() => {
      if (editorRef.current?.readSnapshot().value === next.text) editorRef.current.focusAt(cursor);
    });
  };

  return (
    <div className="relative">
      {mentioning ? (
        <div className="absolute inset-x-0 bottom-full z-10">
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={describing && described.isPending}
            triggerKind={describing ? "chat" : "path"}
            listLabel="Chats"
            emptyStateText="No matching chats."
            activeItemId={activeItemId}
            onHighlightedItemChange={(id) => setHighlight({ query: trigger.query, id })}
            onSelect={select}
          />
        </div>
      ) : null}
      <form
        className="relative flex items-end gap-2 rounded-3xl border border-border bg-background py-2 pr-2 pl-4 shadow-xs focus-within:border-ring"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="min-w-0 flex-1 py-1">
          <ComposerPromptEditor
            editorRef={editorRef}
            value={draft.text}
            cursor={draft.cursor}
            contextRecords={contextRecords}
            skills={[]}
            disabled={false}
            placeholder="Ask about your chats… @ to mention a chat"
            ariaLabel="Ask Overview"
            suggestionListId={listId}
            activeSuggestionId={
              activeItemId && mentioning
                ? composerSuggestionOptionId(listId, activeItemId)
                : undefined
            }
            className="max-h-40 min-h-6 text-sm"
            onChange={(text, cursor, expandedCursor, suppressTrigger) => {
              setDraft({ text, cursor });
              setTrigger(suppressTrigger ? null : detectComposerTrigger(text, expandedCursor));
            }}
            onCommandKeyDown={(key, event) => {
              if (event.isComposing) return false;
              if (key === "Enter" && (event.metaKey || event.ctrlKey)) {
                send();
                return true;
              }
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                (event.shiftKey && key !== "Enter")
              )
                return false;
              if (trigger?.kind === "path" || trigger?.kind === "chat") {
                if (key === "Escape") {
                  dismissTrigger(trigger);
                  return true;
                }
                if ((key === "ArrowDown" || key === "ArrowUp") && items.length > 0) {
                  const index = items.findIndex((item) => item.id === activeItemId);
                  const next =
                    items[(index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length]!;
                  setHighlight({ query: trigger.query, id: next.id });
                  return true;
                }
                if ((key === "Enter" || key === "Tab") && !event.shiftKey && activeItemId) {
                  const item = items.find((candidate) => candidate.id === activeItemId);
                  if (item) select(item);
                  return true;
                }
              }
              if (key === "Enter" && !event.shiftKey) {
                send();
                return true;
              }
              return false;
            }}
            onPaste={() => {}}
          />
        </div>
        <Button
          type="submit"
          size="icon-sm"
          disabled={draft.text.trim().length === 0 || draft.text.length > 4_000}
          aria-label="Send"
        >
          <ArrowUpIcon />
        </Button>
      </form>
      {draft.text.length > 4_000 ? (
        <p className="pt-1 text-xs text-muted-foreground">
          Keep your question under 4,000 characters.
        </p>
      ) : null}
    </div>
  );
}
