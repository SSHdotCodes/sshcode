import { HarnessMascot } from "../../components/HarnessMascot";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  HarnessDefaultsPatch,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import {
  availableDefaultHarnesses,
  harnessDefaultsControls,
} from "@t3tools/shared/harnessDefaults";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useHarnessDefaults } from "../../lib/harnessDefaultsFromProviders";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const CONFIG = "__harness_config__";

export function HarnessDefaultsSection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return selectedTargets.map((environment) => (
    <EnvironmentHarnessDefaults
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      providers={environment.serverConfig.providers}
      instances={environment.serverConfig.settings.providerInstances}
    />
  ));
}

function DefaultsPicker({
  label,
  value,
  configLabel,
  choices,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly configLabel: string;
  readonly choices: ReadonlyArray<{ id: string; label: string }>;
  readonly disabled: boolean;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = choices.find((choice) => choice.id === value);
  const items = [{ id: CONFIG, label: configLabel }, ...choices];
  return (
    <ControlPillMenu
      title={label}
      actions={items.map((item) => ({
        id: item.id,
        title: item.label,
        state: (selected ? value === item.id : item.id === CONFIG) ? "on" : "off",
        attributes: { disabled },
      }))}
      onPressAction={({ nativeEvent }) => {
        if (!disabled) onChange(nativeEvent.event === CONFIG ? null : nativeEvent.event);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected?.label ?? configLabel}`}
        disabled={disabled}
        className="min-h-14 flex-row items-center justify-between gap-3 px-4 py-3 disabled:opacity-40"
      >
        <Text className="shrink-0 text-base text-foreground">{label}</Text>
        <Text className="min-w-0 max-w-[65%] flex-1 text-right text-base text-foreground-muted">
          {selected?.label ?? configLabel}
        </Text>
      </Pressable>
    </ControlPillMenu>
  );
}

function EnvironmentHarnessDefaults({
  environmentId,
  label,
  providers,
  instances,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: ServerSettings["providerInstances"];
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.harnessDefaultsState({ environmentId, input: {} }),
  );
  const permission = useAtomValue(
    serverEnvironment.updateHarnessDefaults.permissionAtom(environmentId),
  );
  const runUpdate = useAtomCommand(serverEnvironment.updateHarnessDefaults, {
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  // Until the defaults stream arrives (or when it cannot), show the choices
  // the server already applied to its providers rather than "Last used".
  const state = useHarnessDefaults(environmentId, query.data, providers);
  const disabled = !permission || pending || !query.isSuccess;
  const available = availableDefaultHarnesses(providers);
  const update = async (patch: HarnessDefaultsPatch) => {
    setPending(true);
    try {
      await runUpdate({ environmentId, input: patch });
    } finally {
      setPending(false);
    }
  };
  return (
    <View className="gap-6">
      <SettingsSection title={`Defaults · ${label}`}>
        <DefaultsPicker
          label="Default harness"
          value={state?.defaultHarness}
          configLabel="Last used"
          choices={available.map((provider) => ({
            id: provider.instanceId,
            label: provider.displayName ?? provider.instanceId,
          }))}
          disabled={disabled}
          onChange={(id) =>
            void update({ defaultHarness: id as HarnessDefaultsPatch["defaultHarness"] })
          }
        />
        <Text className="px-4 pb-4 text-sm text-foreground-muted">
          Defaults for new chats on this server, shared with your Mac. Unset choices use the last
          choice on this device, then the harness config when there is no history.
        </Text>
        {state?.defaultHarness &&
        !available.some((provider) => provider.instanceId === state.defaultHarness) ? (
          <Text className="px-4 pb-4 text-sm text-foreground-muted">
            The selected harness is unavailable. New chats use the last-used harness.
          </Text>
        ) : null}
        {query.error ? (
          <Text className="px-4 pb-4 text-sm text-danger-foreground">{query.error}</Text>
        ) : null}
      </SettingsSection>
      {state
        ? available.map((provider) => {
            const controls = harnessDefaultsControls(provider, state);
            const name = provider.displayName ?? provider.instanceId;
            const patch = (
              value: NonNullable<HarnessDefaultsPatch["harnesses"]>[typeof provider.instanceId],
            ) => void update({ harnesses: { [provider.instanceId]: value } });
            return (
              <SettingsSection
                key={provider.instanceId}
                title={name}
                titleIcon={
                  <HarnessMascot
                    driver={provider.driver}
                    agentId={harnessMascotAgentId(
                      provider.driver,
                      instances[provider.instanceId]?.config,
                    )}
                    still
                    size={24}
                  />
                }
              >
                <DefaultsPicker
                  label="Model"
                  value={controls.override?.model}
                  configLabel={`Last used (or ${controls.nativeModelLabel})`}
                  choices={provider.models.map((model) => ({ id: model.slug, label: model.name }))}
                  disabled={disabled}
                  onChange={(model) => patch({ model })}
                />
                {controls.options.map((option) => (
                  <DefaultsPicker
                    key={option.id}
                    label={option.label}
                    value={controls.override?.options?.[option.id]}
                    configLabel={`Last used (or ${option.options.find((choice) => choice.id === option.nativeValue)?.label ?? option.nativeValue ?? "Catalog default"})`}
                    choices={option.options.map((choice) => ({
                      id: choice.id,
                      label: choice.label,
                    }))}
                    disabled={disabled}
                    onChange={(value) => patch({ options: { [option.id]: value } })}
                  />
                ))}
                {controls.warnings.map((warning) => (
                  <Text key={warning} className="px-4 pb-3 text-sm text-foreground-muted">
                    {warning}
                  </Text>
                ))}
                {controls.override ? (
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Reset harness defaults"
                    disabled={disabled}
                    onPress={() => patch(null)}
                  />
                ) : null}
              </SettingsSection>
            );
          })
        : null}
    </View>
  );
}
