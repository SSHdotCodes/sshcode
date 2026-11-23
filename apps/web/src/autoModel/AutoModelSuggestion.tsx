import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useAutoModelPill } from "./useAutoModelPill";
import { useAutoModelEvaluation } from "./useAutoModelEvaluation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { type AutoModelSelection } from "@t3tools/shared/autoModel/recommendAutoModel";
import { readThreadShells } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useComposerDraftStore } from "../composerDraftStore";
import { useModelPicks } from "../components/usage/useModelPicks";
import {
  autoModelCandidates,
  autoModelCanEvaluate,
  EMPTY_AUTO_MODEL_DRAFT,
  mergeAutoModelEvaluation,
} from "./autoModel.logic";
import { updateAutoModelDraft } from "./draftState";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import type { ModelEsque } from "../components/chat/providerIconUtils";
import "./autoModel.css";

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();
/** After "no answer" (switched off, no key, models resting) the server is left alone this long. */
const DECISION_RETRY_MS = 60_000;
const decisionRestsUntil = new Map<EnvironmentId, number>();

export function AutoModelSuggestion(props: {
  anchor: HTMLButtonElement | null;
  target: ChatComposerProps["composerDraftTarget"];
  environmentId: EnvironmentId;
  text: string;
  attachmentCount: number;
  currentSelection: ModelSelection;
  models: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  pickerOpen: boolean;
  busy: boolean;
  onSelect: (selection: ModelSelection) => void;
}) {
  const [now] = useState(Date.now);
  const environments = useMemo(() => new Set([props.environmentId]), [props.environmentId]);
  const { picks, providers, table } = useModelPicks(environments, NO_HIDDEN_PROVIDERS, now);
  const draft = useComposerDraftStore((store) => store.getComposerDraft(props.target));
  const state = draft?.autoModel ?? EMPTY_AUTO_MODEL_DRAFT;
  const remembered = useComposerDraftStore((store) => store.stickyOptionsByModelByProvider);
  const environmentId = props.environmentId;
  // Read when the evaluation runs. Subscribing to the chat list here re-rendered this on every
  // update of every chat and kept restarting the evaluation.
  const getHistory = useCallback(
    () =>
      readThreadShells()
        .filter((chat) => chat.environmentId === environmentId)
        .map((chat) => ({
          createdBy: chat.source.createdBy,
          createdAt: Date.parse(chat.createdAt),
          modelSelection: chat.modelSelection,
        })),
    [environmentId],
  );
  const candidates = useMemo(
    () => autoModelCandidates({ providers, models: props.models, picks, table, now }),
    [providers, props.models, picks, table, now],
  );
  const fallbacks = useMemo(() => {
    const selection = (kind: "quality" | "speed" | "frugal"): AutoModelSelection | null => {
      const route = picks.picks[kind].winner?.route;
      if (!route?.instanceId) return null;
      const options = remembered[ProviderInstanceId.make(route.instanceId)]?.[route.model];
      return { instanceId: route.instanceId, model: route.model, ...(options ? { options } : {}) };
    };
    return {
      quality: selection("quality"),
      speed: selection("speed"),
      frugal: selection("frugal"),
    };
  }, [picks, remembered]);
  const askDecisionModel = useAtomCommand(serverEnvironment.decideAutoModelTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const canAskDecisionModel = useAtomValue(
    serverEnvironment.decideAutoModelTask.permissionAtom(environmentId),
  );
  const decide = useCallback(
    async (input: { text: string; attachmentCount: number }) => {
      if (Date.now() < (decisionRestsUntil.get(environmentId) ?? 0)) return null;
      const result = await askDecisionModel({ environmentId, input });
      const answer = result._tag === "Success" ? result.value : null;
      if (answer === null) decisionRestsUntil.set(environmentId, Date.now() + DECISION_RETRY_MS);
      return answer?.quick ?? null;
    },
    [askDecisionModel, environmentId],
  );
  const canEvaluate = autoModelCanEvaluate({
    enabled: true,
    hasMessages: false,
    busy: props.busy,
    state,
  });

  const onEvaluation = useCallback<Parameters<typeof useAutoModelEvaluation>[0]["onEvaluation"]>(
    (difficulty, recommendation) => {
      if (
        !difficulty &&
        !useComposerDraftStore.getState().getComposerDraft(props.target)?.autoModel
      )
        return;
      updateAutoModelDraft(props.target, (previous) =>
        mergeAutoModelEvaluation(previous, difficulty, recommendation),
      );
    },
    [props.target],
  );
  useAutoModelEvaluation({
    enabled: canEvaluate,
    text: props.text,
    attachmentCount: props.attachmentCount,
    currentSelection: props.currentSelection,
    candidates,
    getHistory,
    decide: canAskDecisionModel ? decide : undefined,
    picks: fallbacks,
    onEvaluation,
  });

  const {
    displayed: recommendation,
    acknowledged,
    withdrawn,
    exiting,
    acknowledge,
  } = useAutoModelPill(
    state.recommendation,
    canEvaluate,
    props.text.trim().length >= 12 || props.attachmentCount > 0,
  );
  const currentModel = props.models
    .get(props.currentSelection.instanceId)
    ?.find((model) => model.slug === props.currentSelection.model);
  const currentLabel =
    currentModel?.shortName ?? currentModel?.name ?? props.currentSelection.model;
  const visible =
    props.anchor !== null && recommendation !== null && !props.busy && !props.pickerOpen;
  useEffect(() => {
    if (visible && state.recommendation && !state.shown && !acknowledged && !exiting) {
      updateAutoModelDraft(props.target, (previous) => ({ ...previous, shown: true }));
    }
  }, [visible, state.recommendation, state.shown, acknowledged, exiting, props.target]);

  // The pill floats over the composer's last text rows, so the composer makes room for it:
  // short prompts keep their height, longer ones end above the pill instead of under it.
  useEffect(() => {
    const surface = visible ? props.anchor?.closest("[data-chat-composer-surface]") : null;
    if (!surface) return;
    surface.setAttribute("data-auto-model-suggesting", "");
    return () => surface.removeAttribute("data-auto-model-suggesting");
  }, [visible, props.anchor]);

  if (!visible || !recommendation || !props.anchor) return null;
  return (
    <PopoverPrimitive.Root open modal={false}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={props.anchor}
          side="top"
          align="start"
          sideOffset={8}
          className="z-50"
        >
          <PopoverPrimitive.Popup
            aria-label="Model suggestion"
            initialFocus={false}
            finalFocus={false}
            data-auto-model-pill
            className="relative flex h-6 max-w-max items-center whitespace-nowrap rounded-full border border-border/70 bg-popover text-xs text-popover-foreground shadow-sm data-withdrawn:text-muted-foreground [-webkit-app-region:no-drag]"
            data-exiting={exiting || undefined}
            data-withdrawn={withdrawn || undefined}
          >
            <span
              aria-hidden
              className="absolute bottom-0 left-5 size-1.5 translate-y-1/2 rotate-45 border-r border-b border-border/70 bg-popover"
            />
            <button
              type="button"
              tabIndex={-1}
              className="relative flex h-full min-w-0 items-center gap-1 rounded-full px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onPointerDown={(event) => event.preventDefault()}
              disabled={acknowledged || withdrawn || exiting}
              onClick={() => {
                updateAutoModelDraft(props.target, (previous) => ({ ...previous, accepted: true }));
                acknowledge();
                props.onSelect({
                  ...recommendation.selection,
                  instanceId: ProviderInstanceId.make(recommendation.selection.instanceId),
                });
              }}
            >
              {acknowledged || withdrawn ? (
                <CheckIcon className="size-3" aria-hidden />
              ) : (
                <SparklesIcon data-auto-model-spark className="size-3" aria-hidden />
              )}
              {acknowledged
                ? "Selected"
                : withdrawn
                  ? `Staying on ${currentLabel}`
                  : `${recommendation.tier === "fast" ? "Simple task" : "Needs more power"} · use ${recommendation.label}`}
            </button>
            {!acknowledged && !withdrawn && !exiting ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label="Dismiss model suggestion"
                className="relative flex h-full items-center rounded-full pr-1.5 text-muted-foreground hover:text-foreground"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  updateAutoModelDraft(props.target, (previous) => ({
                    ...previous,
                    dismissed: true,
                  }));
                }}
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            ) : null}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
