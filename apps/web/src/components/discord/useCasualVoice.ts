import { casualVisibleText } from "@t3tools/shared/casualVoice";
import { useAtomValue } from "@effect/atom-react";
import {
  casualVoiceConfigured,
  casualVoiceRoutingKey,
  createCasualVoiceStore,
} from "@t3tools/client-runtime/casualVoice";
import type {
  EnvironmentId,
  ThreadId,
  MessageId,
  TurnItemId,
  CasualVoiceRequest,
  CasualVoiceDecision,
  CasualVoiceDisplay,
  CasualVoiceRole,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const store = createCasualVoiceStore();
export function useCasualVoice(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  active = true,
) {
  const key = `${environmentId}\n${threadId}`;
  const command = useAtomCommand(serverEnvironment.casualVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const allowed = useAtomValue(
    serverEnvironment.casualVoice.permissionAtom(active ? environmentId : null),
  );
  const backendAllowed = useAtomValue(
    serverEnvironment.casualVoice.permissionAtom(active ? environmentId : null, {
      action: "configure",
      backend: null,
    }),
  );
  const send = useCallback(
    async (input: CasualVoiceRequest) => {
      if (!environmentId || !allowed) return null;
      const result = await command({ environmentId, input });
      return result._tag === "Success" ? result.value : null;
    },
    [command, environmentId, allowed],
  );
  const readState = () => store.get(key);
  const state = useSyncExternalStore(store.subscribe, readState, readState);
  useEffect(() => {
    if (active && threadId && allowed) void store.load(key, threadId, send);
  }, [active, key, threadId, send, allowed]);
  const configure = useCallback(
    (patch: Omit<Extract<CasualVoiceRequest, { action: "configure" }>, "action" | "threadId">) =>
      threadId
        ? store.configure(key, { action: "configure", threadId, ...patch }, send)
        : Promise.resolve(false),
    [key, threadId, send],
  );
  const rewrite = useCallback(
    (
      messageId: MessageId,
      runId: string | null = null,
      role: CasualVoiceRole = "final",
      reasoningItemId?: TurnItemId,
    ) =>
      threadId
        ? store.rewrite(key, threadId, messageId, send, runId, role, reasoningItemId)
        : Promise.resolve(null),
    [key, threadId, send],
  );
  const refresh = useCallback(
    () => (threadId ? store.load(key, threadId, send) : Promise.resolve()),
    [key, threadId, send],
  );
  const feedback = useCallback(
    (inputHash: string) =>
      threadId ? store.feedback(threadId, inputHash, send) : Promise.resolve(),
    [threadId, send],
  );
  return {
    state,
    loaded: store.loaded(key),
    configure,
    rewrite,
    feedback,
    allowed,
    backendAllowed,
    refresh,
  };
}
export function useCasualMessage(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  messageId: MessageId,
  original: string,
  streaming: boolean,
  active: boolean,
  runId: string | null = null,
  role: CasualVoiceRole = "final",
  visible = true,
  reasoningItemId?: TurnItemId,
) {
  const { state, loaded, rewrite, feedback, allowed } = useCasualVoice(
    environmentId,
    threadId,
    active,
  );
  const voiceKey = `${environmentId}\n${threadId}`;
  const target = `${voiceKey}\n${messageId}\n${reasoningItemId ?? "message"}`;
  const [result, setResult] = useState<{
    target: string;
    original: string;
    backend: string;
    role: CasualVoiceRole;
    display: CasualVoiceDisplay | null;
    decision: CasualVoiceDecision | null;
    live: boolean;
  } | null>(null);
  const observedStreaming = useRef(false);
  useEffect(() => {
    if (!active || !visible) observedStreaming.current = false;
    else if (streaming) observedStreaming.current = true;
  }, [streaming, active, visible]);
  const [showOriginal, setShowOriginal] = useState(false);
  const noted = useRef(false);
  useEffect(() => {
    if (target.length === 0) return;
    noted.current = false;
  }, [target]);
  const revealOriginal = useCallback(() => {
    if (noted.current) return;
    noted.current = true;
    const inputHash = store.hash(voiceKey, messageId, reasoningItemId);
    if (inputHash) void feedback(inputHash);
  }, [feedback, voiceKey, messageId, reasoningItemId]);
  const show = useCallback(() => {
    setShowOriginal((current) => {
      if (!current) revealOriginal();
      return true;
    });
  }, [revealOriginal]);
  const toggle = useCallback(() => {
    setShowOriginal((current) => {
      if (!current) revealOriginal();
      else noted.current = false;
      return !current;
    });
  }, [revealOriginal]);
  const routing = casualVoiceRoutingKey(state);
  const configured = casualVoiceConfigured(state);
  const rewriteVisibility = reasoningItemId === undefined ? visible : false;
  useEffect(() => {
    if (!active || !state.enabled || !configured || streaming || !original) return;
    let mounted = true;
    void rewrite(messageId, runId, role, reasoningItemId)
      .then((display) => {
        if (mounted) {
          const live = observedStreaming.current && rewriteVisibility;
          observedStreaming.current = false;
          setResult({
            target,
            original,
            backend: routing,
            role,
            display,
            decision: store.decision(voiceKey, messageId, reasoningItemId) ?? null,
            live,
          });
        }
      })
      .catch(() => {
        if (mounted)
          setResult({
            target,
            original,
            backend: routing,
            role,
            display: null,
            decision: null,
            live: false,
          });
      });
    return () => {
      mounted = false;
    };
  }, [
    active,
    target,
    state.enabled,
    configured,
    routing,
    streaming,
    original,
    messageId,
    reasoningItemId,
    voiceKey,
    rewrite,
    runId,
    role,
    rewriteVisibility,
  ]);
  const settled =
    result?.target === target &&
    result.original === original &&
    result.backend === routing &&
    result.role === role;
  const rewritten = active && state.enabled && !streaming && settled && result.display !== null;
  return {
    pending:
      active &&
      allowed &&
      ((!loaded && Boolean(threadId)) ||
        (state.enabled && configured && !streaming && Boolean(original) && !settled)),
    text: rewritten && !showOriginal ? casualVisibleText(result.display!) : original,
    display: rewritten && !showOriginal ? result.display : null,
    live: Boolean(rewritten && result.live),
    rewritten,
    showOriginal,
    show,
    toggle,
    decision: settled && result ? result.decision : null,
  };
}

export function useCasualStatus(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  runId: string | null,
  active: boolean,
) {
  const key = `${environmentId}\n${threadId}`;
  const readStatus = () => store.status(key, runId);
  const status = useSyncExternalStore(store.subscribe, readStatus, readStatus);
  return active ? status : "";
}
