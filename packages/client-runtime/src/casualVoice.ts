import { foldCasualStatuses } from "@t3tools/shared/casualVoice";
import type {
  CasualVoiceReply,
  CasualVoiceRequest,
  MessageId,
  ThreadId,
  TurnItemId,
  CasualVoiceDecision,
  CasualVoiceDisplay,
  CasualVoiceRole,
} from "@t3tools/contracts";

type Send = (input: CasualVoiceRequest) => Promise<CasualVoiceReply | null>;
type View = CasualVoiceReply & { readonly models: NonNullable<CasualVoiceReply["models"]> };
const EMPTY: View = { enabled: true, backend: null, models: [] };

/** Identity of the backends and mode that produced a display. */
export function casualVoiceRoutingKey(state: {
  readonly backend: CasualVoiceReply["backend"];
  readonly cloudBackend?: CasualVoiceReply["cloudBackend"];
  readonly mode?: CasualVoiceReply["mode"];
}) {
  return JSON.stringify({
    backend: state.backend,
    cloudBackend: state.cloudBackend ?? null,
    mode: state.mode ?? null,
  });
}
export function casualVoiceConfigured(state: {
  readonly backend: CasualVoiceReply["backend"];
  readonly cloudBackend?: CasualVoiceReply["cloudBackend"];
}) {
  return state.backend !== null || Boolean(state.cloudBackend);
}

/** One settings read per mounted chat, shared by its header and visible messages. */
export function createCasualVoiceStore() {
  const values = new Map<string, View>();
  const pending = new Map<string, Promise<void>>();
  const displays = new Map<
    string,
    {
      key: string;
      runId: string | null;
      backend: string;
      display?: CasualVoiceDisplay;
      decision?: CasualVoiceDecision;
      inputHash?: string;
    }
  >();
  const statuses = new Map<string, string>();
  const refreshStatuses = (key: string) => {
    for (const statusKey of statuses.keys())
      if (statusKey.startsWith(`${key}\n`)) statuses.delete(statusKey);
    const state = values.get(key);
    if (!state?.enabled) return;
    const byRun = new Map<string, string[]>();
    for (const record of displays.values())
      if (
        record.key === key &&
        record.runId &&
        record.display &&
        record.backend === casualVoiceRoutingKey(state)
      ) {
        const lines = byRun.get(record.runId) ?? [];
        lines.push(
          ...record.display.blocks
            .filter((block) => block.kind === "status")
            .map((block) => block.text),
        );
        byRun.set(record.runId, lines);
      }
    for (const [runId, lines] of byRun) statuses.set(`${key}\n${runId}`, foldCasualStatuses(lines));
  };
  const listeners = new Set<() => void>();
  const publish = (key: string, value: CasualVoiceReply) => {
    const previous = values.get(key);
    const models = value.models ?? previous?.models ?? [];
    const mode = value.mode ?? previous?.mode;
    const cloudBackend =
      value.cloudBackend !== undefined ? value.cloudBackend : previous?.cloudBackend;
    const saveTraining = value.saveTraining ?? previous?.saveTraining;
    values.set(key, {
      enabled: value.enabled,
      backend: value.backend,
      models,
      ...(mode !== undefined ? { mode } : {}),
      ...(cloudBackend !== undefined ? { cloudBackend } : {}),
      ...(saveTraining !== undefined ? { saveTraining } : {}),
    });
    if (values.size > 256) values.delete(values.keys().next().value!);
    refreshStatuses(key);
    for (const listener of listeners) listener();
  };
  // Every request takes the next number. A reply sets only the fields it speaks for,
  // and only when no later request already set them, so a failed or slow request
  // never discards a newer success. Enabled is per chat; the rest is per environment.
  let sequence = 0;
  const chatSettledAt = new Map<string, number>();
  const environmentSettledAt = new Map<string, number>();
  const environmentOf = (key: string) => key.split("\n")[0]!;
  const READ = { chat: true, environment: true } as const;
  const settle = (
    key: string,
    reply: CasualVoiceReply,
    at: number,
    authority: { readonly chat: boolean; readonly environment: boolean },
  ) => {
    const environment = environmentOf(key);
    const previous = values.get(key);
    const takeChat =
      previous === undefined || (authority.chat && at > (chatSettledAt.get(key) ?? 0));
    const takeEnvironment =
      previous === undefined ||
      (authority.environment && at > (environmentSettledAt.get(environment) ?? 0));
    if (authority.chat && takeChat)
      chatSettledAt.set(key, Math.max(at, chatSettledAt.get(key) ?? 0));
    if (authority.environment && takeEnvironment)
      environmentSettledAt.set(
        environment,
        Math.max(at, environmentSettledAt.get(environment) ?? 0),
      );
    if (previous === undefined || (takeChat && takeEnvironment)) publish(key, reply);
    else if (takeEnvironment) publish(key, { ...reply, enabled: previous.enabled });
    else if (takeChat) publish(key, { ...previous, enabled: reply.enabled });
    if (!authority.environment || !takeEnvironment || authority === READ) return;
    for (const [other, state] of values) {
      if (other === key || environmentOf(other) !== environment) continue;
      publish(other, {
        ...state,
        backend: reply.backend,
        ...(reply.models !== undefined ? { models: reply.models } : {}),
        ...(reply.mode !== undefined ? { mode: reply.mode } : {}),
        ...(reply.cloudBackend !== undefined ? { cloudBackend: reply.cloudBackend } : {}),
        ...(reply.saveTraining !== undefined ? { saveTraining: reply.saveTraining } : {}),
      });
    }
  };
  return {
    get: (key: string) => values.get(key) ?? EMPTY,
    loaded: (key: string) => values.has(key),
    status: (key: string, runId: string | null) =>
      runId ? (statuses.get(`${key}\n${runId}`) ?? "") : "",
    hash: (key: string, messageId: string, reasoningItemId?: string) =>
      displays.get(
        `${key}\n${reasoningItemId === undefined ? messageId : `reasoning:${reasoningItemId}`}`,
      )?.inputHash,
    decision: (key: string, messageId: string, reasoningItemId?: string) =>
      displays.get(
        `${key}\n${reasoningItemId === undefined ? messageId : `reasoning:${reasoningItemId}`}`,
      )?.decision,
    async feedback(threadId: ThreadId, inputHash: string, send: Send) {
      if (!/^[0-9a-f]{64}$/i.test(inputHash)) return;
      await send({ action: "feedback", threadId, inputHash: inputHash.toLowerCase() }).catch(
        () => null,
      );
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(key: string, threadId: ThreadId, send: Send) {
      if (!pending.has(key)) {
        const at = ++sequence;
        const work = send({ action: "get", threadId })
          .then((value) => {
            if (value) settle(key, value, at, READ);
            else if (!values.has(key)) publish(key, EMPTY);
          })
          .catch(() => {
            if (!values.has(key)) publish(key, EMPTY);
          })
          .finally(() => {
            pending.delete(key);
          });
        pending.set(key, work);
      }
      await pending.get(key);
    },
    async configure(
      key: string,
      input: Extract<CasualVoiceRequest, { action: "configure" }>,
      send: Send,
    ) {
      const at = ++sequence;
      const result = await send(input);
      if (!result) return false;
      settle(key, result, at, {
        chat: input.enabled !== undefined,
        environment:
          input.backend !== undefined ||
          input.cloudBackend !== undefined ||
          input.mode !== undefined ||
          input.saveTraining !== undefined,
      });
      return true;
    },
    async rewrite(
      key: string,
      threadId: ThreadId,
      messageId: MessageId,
      send: Send,
      runId: string | null = null,
      role: CasualVoiceRole = "final",
      reasoningItemId?: TurnItemId,
    ) {
      const at = ++sequence;
      const result = await send({
        action: "rewrite",
        threadId,
        messageId,
        role,
        ...(reasoningItemId === undefined ? {} : { reasoningItemId }),
      });
      if (result) settle(key, result, at, READ);
      if (result?.display || result?.decision) {
        displays.set(
          `${key}\n${reasoningItemId === undefined ? messageId : `reasoning:${reasoningItemId}`}`,
          {
            key,
            runId,
            backend: casualVoiceRoutingKey(values.get(key) ?? result),
            ...(result.display ? { display: result.display } : {}),
            ...(result.decision ? { decision: result.decision } : {}),
            ...(result.inputHash ? { inputHash: result.inputHash } : {}),
          },
        );
        if (displays.size > 512) displays.delete(displays.keys().next().value!);
        refreshStatuses(key);
        for (const listener of listeners) listener();
      }
      return result?.display ?? null;
    },
  };
}
