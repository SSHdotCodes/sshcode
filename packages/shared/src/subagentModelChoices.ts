import { type ContinueOnHistoryEntry, type UsedModel, usedModels } from "./continueOnModel.ts";

/** One subagent a chat has run: when, and on what. */
export interface SubagentModelUse {
  readonly startedAt: number;
  readonly modelSelection: UsedModel;
}

/** How many models the "New subagent" picker offers. */
export const SUBAGENT_MODEL_CHOICES = 6;

const SUBAGENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const modelKey = (model: Pick<UsedModel, "instanceId" | "model">) =>
  `${model.instanceId}\0${model.model}`;

/**
 * The models offered when the user starts a subagent themselves: first the ones this chat's
 * subagents ran on in the last month, the latest first and with the options of that latest
 * run, so the picker opens on the model the chat's last subagent used. Then the ones the user
 * starts chats with. Never a provider default the user has not picked.
 */
export function subagentModelChoices(input: {
  readonly subagents: ReadonlyArray<SubagentModelUse>;
  readonly chats: ReadonlyArray<ContinueOnHistoryEntry>;
  readonly now: number;
  /**
   * False for a model that cannot be offered now: retired, replaced by a newer release, hidden
   * or on a provider that is not ready. Asked before the list is cut to size.
   */
  readonly accepts?: (model: UsedModel) => boolean;
}): UsedModel[] {
  const accepts = input.accepts ?? (() => true);
  const latest = new Map<string, SubagentModelUse>();
  for (const use of input.subagents) {
    const age = input.now - use.startedAt;
    if (!(age >= 0) || age > SUBAGENT_WINDOW_MS) continue;
    const key = modelKey(use.modelSelection);
    const seen = latest.get(key);
    if (seen === undefined || use.startedAt > seen.startedAt) latest.set(key, use);
  }
  const fromSubagents = Array.from(latest.values())
    .sort(
      (a, b) =>
        b.startedAt - a.startedAt ||
        modelKey(a.modelSelection).localeCompare(modelKey(b.modelSelection)),
    )
    .map(({ modelSelection: { instanceId, model, options } }): UsedModel =>
      options && options.length > 0 ? { instanceId, model, options } : { instanceId, model },
    )
    .filter(accepts);
  const offered = new Set(fromSubagents.map(modelKey));
  const fromChats = usedModels(input.chats, input.now).filter(
    (model) => !offered.has(modelKey(model)) && accepts(model),
  );
  return [...fromSubagents, ...fromChats].slice(0, SUBAGENT_MODEL_CHOICES);
}

const DEFAULT_SPEEDS = new Set(["default", "standard", "auto", "normal"]);

/**
 * "xhigh · ultrafast": the effort and speed a choice runs with, so its label says what a
 * subagent started from it will use. Other options ride along unnamed.
 */
export function usualOptionsLabel(options: UsedModel["options"]): string {
  const parts: string[] = [];
  for (const option of options ?? []) {
    if (/effort/iu.test(option.id)) {
      if (typeof option.value === "string") parts.push(option.value);
    } else if (/tier|speed|fast/iu.test(option.id)) {
      if (option.value === true) parts.push("fast");
      else if (typeof option.value === "string" && !DEFAULT_SPEEDS.has(option.value.toLowerCase()))
        parts.push(option.value);
    }
  }
  return parts.join(" · ");
}
