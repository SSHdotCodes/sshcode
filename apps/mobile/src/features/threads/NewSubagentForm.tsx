import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  subagentsOffConfirmation,
  subagentsToggleNeedsConfirm,
} from "@t3tools/shared/chatControls";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Keyboard, Pressable, ScrollView, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { FastModeBolt } from "../../components/FastModeBolt";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ListSection } from "../../components/ListSection";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { modelTraits, resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useCoarseNow } from "../../lib/useCoarseNow";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { newSubagentCandidates } from "./newSubagentModels";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";

interface AgentsTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * The one quiet line under the Agents list: start a subagent yourself, and the chat's
 * subagents switch, small because it is rarely touched.
 */
export function AgentsFooter(props: AgentsTarget & { readonly onNewSubagent: () => void }) {
  const { environmentId, threadId } = props;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const insets = useSafeAreaInsets();
  const shell = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
  );
  const runChatControlsCommand = useAtomCommand(serverEnvironment.chatControlsCommand, {
    label: "chat controls",
    reportFailure: false,
  });
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  // The tap shows at once; the chat's own value takes over as soon as it changes.
  const [tapped, setTapped] = useState<{ readonly value: boolean; readonly from: boolean } | null>(
    null,
  );
  if (!canOperate || shell === null || shell === undefined) return null;
  const subagentsEnabled = shell.subagentsEnabled !== false;
  if (tapped !== null && tapped.from !== subagentsEnabled) setTapped(null);
  const shown = tapped?.value ?? subagentsEnabled;
  const setSubagents = (enabled: boolean) => {
    const send = async () => {
      const pending = { value: enabled, from: subagentsEnabled };
      setTapped(pending);
      const result = await runChatControlsCommand({
        environmentId,
        input: { action: "subagents", threadId, enabled },
      });
      if (result._tag === "Failure") setTapped((current) => (current === pending ? null : current));
    };
    if (!subagentsToggleNeedsConfirm(enabled)) return void send();
    // The model's name as the picker shows it, not its id.
    const lead = shell.modelSelection;
    const copy = subagentsOffConfirmation(
      config?.providers
        .find((provider) => provider.instanceId === lead.instanceId)
        ?.models.find((model) => model.slug === lead.model)?.name ?? lead.model,
    );
    Alert.alert(copy.question, `${copy.detail}\n\n${copy.secondary}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Turn off", style: "destructive", onPress: () => void send() },
    ]);
  };
  return (
    <View
      className="flex-row items-center justify-between border-t border-border-subtle px-4 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      {/* A subagent reports to a turn of the chat: a chat that never ran has none. */}
      {shell.latestRun === null ? (
        <View />
      ) : (
        <ControlPill
          variant="pill"
          icon="plus"
          label="New subagent"
          onPress={() => {
            void Haptics.selectionAsync();
            props.onNewSubagent();
          }}
        />
      )}
      {/* Small and quiet: it is rarely touched, but this is where it lives. */}
      <View className="flex-row items-center gap-2">
        <Text className="text-sm text-foreground-muted">Subagents</Text>
        <ThemedSwitch
          accessibilityLabel="Subagents"
          accessibilityHint="Lets this chat's agent start subagents"
          value={shown}
          onValueChange={setSubagents}
          style={{ transform: [{ scale: 0.82 }] }}
        />
      </View>
    </View>
  );
}

/**
 * Start a subagent yourself: the task, the model, Start. It works beside the chat's agent,
 * which gets the card and the result. Shown in place of the Agents list, so neither crowds
 * the other.
 */
export function NewSubagentForm(props: AgentsTarget & { readonly onClose: () => void }) {
  const { environmentId, threadId } = props;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const ref = scopeThreadRef(environmentId, threadId);
  const projectId = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (detail) => detail?.projection.thread.projectId ?? null,
  );
  const subagents = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (detail) => detail?.projection.subagents,
  );
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const now = useCoarseNow();
  const candidates = useMemo(() => {
    if (!config) return [];
    // Read once, not subscribed: other chats' updates must not re-render the sheet.
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
    return newSubagentCandidates({
      groups: groupByProvider(buildModelOptions(config, null, undefined, projectId)),
      providers: config.providers,
      subagents: subagents ?? [],
      history,
      now,
    });
  }, [config, environmentId, projectId, subagents, now]);

  const startSubagent = useAtomCommand(threadEnvironment.startSubagent, { reportFailure: false });
  const [draft, setDraft] = useState("");
  // Until one is picked: what this chat's subagents last ran on, with that run's options.
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const [accountPinned, setAccountPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = chosen ?? candidates[0]?.selection ?? null;

  // The model row opens the app's full picker: every model, its account, effort and speed.
  const modelOptions = useMemo(
    () => buildModelOptions(config, selection, undefined, projectId),
    [config, selection, projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const selectedOption =
    selection === null
      ? undefined
      : modelOptions.find(
          (option) =>
            option.selection.instanceId === selection.instanceId &&
            option.selection.model === selection.model,
        );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selection?.options,
      }),
    [selectedOption?.capabilities, selection?.options],
  );
  const traits = modelTraits({ capabilities: selectedOption?.capabilities, selection });
  const navigation = useNavigation();
  const picker = useExistingThreadSettingsRoutePresentation();
  const pickerOwnerId = `new-subagent:${environmentId}:${threadId}`;
  const pickerSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: pickerOwnerId,
      environmentId,
      projectId,
      providerGroups,
      selectedModel: selection,
      accountPinned,
      onSelectModel: (option, pinned) => {
        setChosen(option.selection);
        setAccountPinned(pinned);
      },
      optionDescriptors,
      onUpdateOptionSelections: (options) =>
        setChosen((current) => {
          const base = current ?? selection;
          return base === null ? current : { ...base, options };
        }),
      // The subagent works with the lead chat's access.
      runtimeMode: "full-access",
      onUpdateRuntimeMode: () => undefined,
      runtimeHidden: true,
    }),
    [
      accountPinned,
      environmentId,
      optionDescriptors,
      pickerOwnerId,
      projectId,
      providerGroups,
      selection,
    ],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const { present: presentPicker, clear: clearPicker } = picker;
  const openPicker = () => {
    void Haptics.selectionAsync();
    Keyboard.dismiss();
    presentPicker(pickerSession);
    setPickerOpen(true);
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  };
  // The picker reads the session it was handed: keep it current while it is up.
  useEffect(() => {
    if (pickerOpen) presentPicker(pickerSession);
  }, [pickerOpen, pickerSession, presentPicker]);
  useEffect(() => () => clearPicker(pickerOwnerId), [clearPicker, pickerOwnerId]);
  // Back on this sheet: the picker is gone.
  useFocusEffect(
    useCallback(() => {
      setPickerOpen(false);
      clearPicker(pickerOwnerId);
    }, [clearPicker, pickerOwnerId]),
  );

  const modelLabel = selectedOption?.label ?? selection?.model ?? "";
  const traitsLabel = [traits.effort, traits.speed].filter(Boolean).join(", ");
  const task = draft.trim();
  const start = async () => {
    if (selection === null || task.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    void Haptics.selectionAsync();
    const result = await startSubagent({
      environmentId,
      input: { threadId, task, modelSelection: selection, creationSource: "mobile" },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      // What was typed stays in the box.
      setError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "The subagent could not be started. Try again.",
      );
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Back to the list, where the new subagent now runs.
    props.onClose();
  };

  return (
    <>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 pt-2 pb-4"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {selection === null ? (
          <Text className="px-2 pt-4 text-base text-foreground-muted">
            No model is ready to run one. Turn a provider on in Settings first.
          </Text>
        ) : (
          <>
            <ListSection>
              <TextInput
                multiline
                autoFocus
                value={draft}
                editable={!busy}
                onChangeText={(text) => {
                  setDraft(text);
                  if (error !== null) setError(null);
                }}
                placeholder="What should it do?"
                accessibilityLabel="Task for the new subagent"
                className="max-h-56 min-h-28 px-4 py-3 text-base"
                style={{ textAlignVertical: "top" }}
              />
            </ListSection>
            <ListSection title="Model" footer="It reports back to this chat's agent.">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Model: ${[modelLabel, traitsLabel].filter(Boolean).join(", ")}`}
                accessibilityHint="Opens the model picker"
                disabled={busy}
                onPress={openPicker}
                className="active:opacity-70"
              >
                <ListRowLayout
                  leading={
                    <ProviderIcon
                      iconUrl={selectedOption?.providerIconUrl}
                      provider={selectedOption?.providerDriver}
                      size={22}
                    />
                  }
                  label={modelLabel}
                  {...(selectedOption ? { description: selectedOption.providerLabel } : {})}
                  accessory={
                    <View className="shrink-0 flex-row items-center gap-1.5">
                      {traits.effort ? (
                        <Text className="text-base text-foreground-muted">{traits.effort}</Text>
                      ) : null}
                      {traits.speed ? <FastModeBolt /> : null}
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                        weight="semibold"
                      />
                    </View>
                  }
                />
              </Pressable>
            </ListSection>
            {error === null ? null : (
              <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            )}
          </>
        )}
      </ScrollView>
      <View
        className="flex-row items-center justify-between border-t border-border-subtle px-4 pt-2"
        // The keyboard already covers the home indicator's inset.
        style={{ paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 12) }}
      >
        <ControlPill variant="pill" label="Cancel" disabled={busy} onPress={props.onClose} />
        {selection === null ? null : (
          <ControlPill
            variant="primary"
            label={busy ? "Starting…" : "Start"}
            accessibilityLabel={busy ? "Starting subagent" : "Start subagent"}
            disabled={task.length === 0 || busy}
            onPress={() => void start()}
          />
        )}
      </View>
    </>
  );
}
