import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { continueOnOtherPlan } from "@t3tools/client-runtime/plan-tip";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Pressable } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import {
  buildModelOptions,
  groupByProvider,
  resolveProvidersEnabledForProject,
} from "../../lib/modelOptions";
import { useCoarseNow } from "../../lib/useCoarseNow";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type PhoneContinueCandidate,
  phoneContinueCandidates,
  resolvePhoneContinueDispatch,
} from "./continueOnModelCandidates";

/**
 * "Continue on <model>" under the latest failed run when its provider refused or hit a limit:
 * one tap sends "Continue." on another model, which gets the chat through the handoff. The
 * choices are the models the owner starts chats with.
 */
export function ContinueOnModelButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (detail) => detail?.projection.thread ?? null,
  );
  const latestFailed = useAtomValue(environmentThreadDetails.threadAtom(ref), (detail) => {
    const latest = detail?.projection.runs.at(-1);
    return latest?.id === props.runId && latest.status === "failed";
  });
  const allowsProviderSwitch = useAtomValue(environmentThreadDetails.threadAtom(ref), (detail) =>
    detail?.projection
      ? threadAllowsProviderSwitch({ thread: null, projection: detail.projection })
      : false,
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  // Eases in under a run that failed just now; history shows it at rest, since the list
  // remounts rows that scroll back into view.
  const [justFailed] = useState(() => {
    const completedAt = appAtomRegistry
      .get(environmentThreadDetails.threadAtom(ref))
      ?.projection.runs.at(-1)?.completedAt;
    return completedAt != null && Date.now() - DateTime.toEpochMillis(completedAt) < 3_000;
  });
  const config = useAtomValue(environmentServerConfigsAtom).get(props.environmentId);
  const failedInstanceId = thread?.modelSelection.instanceId ?? null;
  const failedModel = thread?.modelSelection.model ?? null;
  const failedOptions = thread?.modelSelection.options;
  const projectId = thread?.projectId ?? null;
  const { environmentId } = props;
  const now = useCoarseNow();
  const candidates = useMemo(() => {
    if (!config || !latestFailed || !allowsProviderSwitch) return [];
    // The chat list is read once a run has failed, not subscribed to: other chats' updates
    // must not re-render this row.
    const history = appAtomRegistry.get(environmentThreadShells.threadShellsAtom).flatMap((chat) =>
      chat.environmentId === environmentId
        ? [
            {
              createdBy: chat.source.createdBy,
              createdAt: Date.parse(chat.createdAt),
              modelSelection: chat.modelSelection,
            },
          ]
        : [],
    );
    const projectProviders = resolveProvidersEnabledForProject(config, projectId);
    const plan =
      failedInstanceId !== null && failedModel !== null
        ? continueOnOtherPlan(
            config.settings.balanceAccounts,
            projectProviders,
            {
              instanceId: failedInstanceId,
              model: failedModel,
            },
            now,
          )
        : null;
    return phoneContinueCandidates(
      groupByProvider(buildModelOptions(config, null, undefined, projectId)),
      failedInstanceId,
      history,
      now,
      plan !== null && failedModel !== null
        ? {
            ...plan,
            model: failedModel,
            ...(failedOptions ? { options: failedOptions } : {}),
          }
        : null,
      config.settings.balanceAccounts ? null : failedModel,
    );
  }, [
    allowsProviderSwitch,
    config,
    environmentId,
    failedInstanceId,
    failedModel,
    failedOptions,
    latestFailed,
    now,
    projectId,
  ]);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "continue on another model");
  const [busy, setBusy] = useState(false);
  const [first, ...others] = candidates;
  if (!latestFailed || !canOperate || thread === null || first === undefined) return null;

  const continueOn = (candidate: PhoneContinueCandidate) => {
    if (busy) return;
    setBusy(true);
    void Haptics.selectionAsync();
    const dispatch = resolvePhoneContinueDispatch({
      config,
      selection: candidate.selection,
      interactionMode: thread.interactionMode,
    });
    void startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: "Continue.",
          attachments: [],
        },
        modelSelection: dispatch.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: dispatch.interactionMode,
        dispatchMode: "auto",
      },
    }).finally(() => setBusy(false));
  };

  return (
    <Animated.View
      className="mt-2 flex-row items-center gap-2"
      style={{ opacity: busy ? 0.5 : 1 }}
      {...(justFailed ? { entering: FadeInDown.duration(240) } : {})}
    >
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => continueOn(first)}
        className="min-h-11 flex-row items-center gap-1.5 self-start rounded-full border border-border px-4"
      >
        <SymbolView name="arrow.right" size={13} tintColorClassName="accent-icon" />
        <Text className="font-t3-medium text-sm text-foreground">
          {busy ? "Continuing…" : `Continue on ${first.label}`}
        </Text>
      </Pressable>
      {others.length > 0 ? (
        <ControlPillMenu
          accessibilityLabel="Continue on another model"
          actions={others.map((candidate) => ({
            id: candidate.key,
            title: candidate.label,
          }))}
          onPressAction={({ nativeEvent }) => {
            const picked = others.find((candidate) => candidate.key === nativeEvent.event);
            if (picked) continueOn(picked);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue on another model"
            disabled={busy}
            className="min-h-11 min-w-11 items-center justify-center rounded-full border border-border"
          >
            <SymbolView name="chevron.down" size={12} tintColorClassName="accent-icon" />
          </Pressable>
        </ControlPillMenu>
      ) : null}
    </Animated.View>
  );
}
