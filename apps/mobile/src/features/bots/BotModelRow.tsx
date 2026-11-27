import { useAtomValue } from "@effect/atom-react";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { FastModeBolt } from "../../components/FastModeBolt";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ProviderIcon } from "../../components/ProviderIcon";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { modelTraits, resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "../threads/ThreadSettingsSheet";

/**
 * A bot's model as one row that opens the app's full model picker, the one a chat uses.
 * `selection` is what shows; `fallback` stands in until one is picked.
 */
export function BotModelRow(props: {
  readonly ownerId: string;
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
  readonly disabled?: boolean;
}) {
  const navigation = useNavigation();
  const config = useAtomValue(environmentServerConfigsAtom).get(props.environmentId);
  const [accountPinned, setAccountPinned] = useState(false);
  const modelOptions = useMemo(
    () => buildModelOptions(config, props.selection, undefined, null),
    [config, props.selection],
  );
  const selection = props.selection;
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
  const { onChange } = props;
  const picker = useExistingThreadSettingsRoutePresentation();
  const session = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: props.ownerId,
      environmentId: props.environmentId,
      projectId: null,
      providerGroups,
      selectedModel: selection,
      accountPinned,
      onSelectModel: (option, pinned) => {
        setAccountPinned(pinned);
        onChange(option.selection);
      },
      optionDescriptors,
      onUpdateOptionSelections: (options) => {
        if (selection !== null) onChange({ ...selection, options });
      },
      // A bot's chat runs with full access, like any chat it starts.
      runtimeMode: "full-access",
      onUpdateRuntimeMode: () => undefined,
      runtimeHidden: true,
    }),
    [
      accountPinned,
      onChange,
      optionDescriptors,
      props.environmentId,
      props.ownerId,
      providerGroups,
      selection,
    ],
  );
  const [open, setOpen] = useState(false);
  const { present, clear } = picker;
  // The picker reads the session it was handed: keep it current while it is up.
  useEffect(() => {
    if (open) present(session);
  }, [open, present, session]);
  useEffect(() => () => clear(props.ownerId), [clear, props.ownerId]);
  useFocusEffect(
    useCallback(() => {
      setOpen(false);
      clear(props.ownerId);
    }, [clear, props.ownerId]),
  );

  const label = selectedOption?.label ?? selection?.model ?? "No model available";
  const traitsLabel = [traits.effort, traits.speed].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Model: ${[label, traitsLabel].filter(Boolean).join(", ")}`}
      accessibilityHint="Opens the model picker"
      disabled={props.disabled === true || config === undefined}
      onPress={() => {
        void Haptics.selectionAsync();
        Keyboard.dismiss();
        present(session);
        setOpen(true);
        navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
      }}
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
        label={label}
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
  );
}
