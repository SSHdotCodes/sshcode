import { useAtomValue } from "@effect/atom-react";
import {
  countProviderAgentToolOverrides,
  filterAgentToolDescriptors,
  replaceAgentToolPolicy,
  resetProviderAgentTools,
  resolveAgentToolSetting,
  setAllProviderAgentToolsEnabled,
  setGlobalAgentToolEnabled,
  setProviderAgentToolEnabled,
  setAgentToolGroupEnabled,
  groupAgentToolDescriptors,
  agentToolSummary,
} from "@t3tools/client-runtime/agent-tools";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentToolPolicy, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { EmptyState } from "../../components/EmptyState";
import { AppText as Text } from "../../components/AppText";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { agentToolsEnvironment, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

function providerToolSource(policy: AgentToolPolicy, tool: string, provider: ProviderInstanceId) {
  const setting = resolveAgentToolSetting(policy, tool, provider);
  switch (setting.source) {
    case "provider-tool":
      return `Custom for this provider. Global default: ${resolveAgentToolSetting(policy, tool).enabled ? "on" : "off"}.`;
    case "provider-default":
      return `Provider default: ${setting.enabled ? "on" : "off"}. Reset to inherit global settings.`;
    case "global-tool":
      return `Inherited global setting: ${setting.enabled ? "on" : "off"}.`;
    case "global-default":
      return `Inherited global default: ${setting.enabled ? "on" : "off"}.`;
  }
}

export function SettingsToolsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Tools" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            Control tools provided by SSHCode. Provider-native CLI tools and external plugin tools
            are not affected. Provider choices override global defaults.
          </Text>
          <TextInput
            accessibilityLabel="Search SSHCode tools"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-2xl border border-border-subtle bg-grouped-card px-4 py-3 text-base text-foreground"
            placeholder="Search tools"
            placeholderTextColorClassName="accent-placeholder"
            returnKeyType="search"
            value={search}
            onChangeText={setSearch}
          />
          {selectedTargets.length === 0 ? (
            <EmptyState
              variant="plain"
              title="Select an environment"
              detail="Connect an environment or select one in the filter to manage its tools."
            />
          ) : (
            selectedTargets.map((environment) => (
              <ToolsEnvironmentSettings
                key={environment.environmentId}
                environment={environment}
                showEnvironmentLabel={selectedTargets.length > 1}
                search={search}
              />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ToolsEnvironmentSettings({
  environment,
  showEnvironmentLabel,
  search,
}: {
  readonly environment: SettingsTarget;
  readonly showEnvironmentLabel: boolean;
  readonly search: string;
}) {
  const environmentId = environment.environmentId;
  const supported = environment.serverConfig.agentToolsSettings === true;
  const query = useEnvironmentQuery(
    supported ? agentToolsEnvironment.state({ environmentId, input: {} }) : null,
  );
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agent tool settings update",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<AgentToolPolicy | null>(null);
  const writeInFlight = useRef(false);
  const state = query.data;
  const policy = optimistic ?? state?.policy;
  useEffect(() => {
    // A successful background retry can replace a retained acknowledged policy too.
    if (!saving && query.isSuccess) setOptimistic(null);
  }, [query.data, query.isSuccess, saving]);
  const visibleTools = useMemo(
    () => filterAgentToolDescriptors(state?.tools ?? [], search),
    [search, state?.tools],
  );
  const providers = environment.serverConfig.providers;
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>();
  const selectedProvider = providers.find((provider) => provider.instanceId === selectedProviderId);
  const providerIds = useMemo(() => providers.map((provider) => provider.instanceId), [providers]);
  const groups = useMemo(() => groupAgentToolDescriptors(state?.tools ?? []), [state?.tools]);
  const disabled = saving || !canWrite || policy === undefined;
  const refreshTools = useAtomCommand(agentToolsEnvironment.refresh, {
    label: "refresh agent tools",
    reportFailure: false,
  });
  const reload = useCallback(async () => {
    if (writeInFlight.current) return;
    writeInFlight.current = true;
    setSaving(true);
    try {
      const result = await refreshTools({ environmentId, input: {} });
      if (result._tag === "Success") setOptimistic(null);
    } finally {
      writeInFlight.current = false;
      setSaving(false);
    }
  }, [environmentId, refreshTools]);
  const sectionTitle = useCallback(
    (title: string) => (showEnvironmentLabel ? `${environment.label} · ${title}` : title),
    [environment.label, showEnvironmentLabel],
  );

  const save = useCallback(
    async (nextPolicy: AgentToolPolicy) => {
      if (!state || writeInFlight.current || !canWrite) return;
      writeInFlight.current = true;
      setSaving(true);
      setSaveError(null);
      const previousPolicy = policy ?? state.policy;
      setOptimistic(nextPolicy);
      try {
        const result = await updateSettings({
          environmentId,
          input: { patch: { agentToolPolicy: nextPolicy } },
        });
        if (result._tag === "Failure") {
          setOptimistic(previousPolicy);
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setSaveError(
              error instanceof Error ? error.message : "The tool settings were not saved.",
            );
          }
        } else {
          setOptimistic(result.value.agentToolPolicy);
        }
        const refreshed = await refreshTools({ environmentId, input: {} });
        if (refreshed._tag === "Success") setOptimistic(null);
      } catch (error) {
        setOptimistic(previousPolicy);
        setSaveError(error instanceof Error ? error.message : "The tool settings were not saved.");
      } finally {
        writeInFlight.current = false;
        setSaving(false);
      }
    },
    [canWrite, environmentId, policy, refreshTools, state, updateSettings],
  );

  if (!supported) {
    return (
      <SettingsSection title={sectionTitle("Tools")}>
        <ListRowLayout
          icon="arrow.clockwise"
          label="Update this environment to manage tools"
          description="This host does not support SSHCode tool settings yet. No request was sent to the older host."
        />
      </SettingsSection>
    );
  }

  if (!state && query.isPending) {
    return (
      <SettingsSection title={sectionTitle("Tools")}>
        <View className="items-center gap-3 px-6 py-8">
          <AppActivityIndicator />
          <Text className="text-sm text-foreground-muted">Loading SSHCode tools…</Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title={sectionTitle("Apply to")}>
        <ControlPillMenu
          actions={[
            {
              id: "global",
              title: "All providers · Global defaults",
              state: selectedProvider === undefined ? "on" : "off",
            },
            ...providers.map((provider) => ({
              id: `provider:${provider.instanceId}`,
              title: provider.displayName ?? provider.driver,
              state: provider === selectedProvider ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent }) =>
            setSelectedProviderId(
              nativeEvent.event === "global"
                ? undefined
                : providers.find(
                    (provider) => `provider:${provider.instanceId}` === nativeEvent.event,
                  )?.instanceId,
            )
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Tool settings provider, ${selectedProvider?.displayName ?? selectedProvider?.driver ?? "All providers"}`}
          >
            <ListRowLayout
              label="Provider"
              detail={selectedProvider?.displayName ?? selectedProvider?.driver ?? "All providers"}
              accessory={
                <SymbolView
                  name="chevron.down"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              }
            />
          </Pressable>
        </ControlPillMenu>
      </SettingsSection>
      {query.error ? (
        <SettingsSection title={sectionTitle("Tool catalog")}>
          <ListRowLayout
            icon="exclamationmark.triangle"
            label="Could not load tools"
            description={query.error}
          />
          <SettingsActionRow icon="arrow.clockwise" label="Retry" onPress={() => void reload()} />
        </SettingsSection>
      ) : null}
      {saveError ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          Tool settings were not saved: {saveError}
        </Text>
      ) : null}
      {!canWrite ? (
        <Text className="px-2 text-sm text-foreground-muted">
          This connection has read-only access. Ask for settings write permission to change tools.
        </Text>
      ) : null}
      {!state || !policy ? null : visibleTools.length === 0 ? (
        <SettingsSection title={sectionTitle("Search results")}>
          <ListRowLayout
            icon="magnifyingglass"
            label="No tools found"
            description="Try a tool name, description, or group."
          />
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            title={sectionTitle("Tool groups")}
            footer={
              selectedProvider
                ? "Group choices apply to this provider."
                : "Group choices change global defaults. Provider overrides still apply."
            }
          >
            {Array.from(groups)
              .filter(([, tools]) => tools.some((tool) => visibleTools.includes(tool)))
              .map(([group, tools]) => {
                const enabled = tools.filter(
                  (tool) =>
                    resolveAgentToolSetting(policy, tool.name, selectedProvider?.instanceId)
                      .enabled,
                ).length;
                return (
                  <SettingsSwitchRow
                    key={group}
                    label={group.slice(0, 1).toUpperCase() + group.slice(1)}
                    subtitle={`${enabled} of ${tools.length} tools enabled`}
                    value={enabled === tools.length}
                    disabled={disabled}
                    onValueChange={(value) =>
                      void save(
                        setAgentToolGroupEnabled(
                          policy,
                          tools,
                          value,
                          selectedProvider?.instanceId,
                        ),
                      )
                    }
                  />
                );
              })}
          </SettingsSection>
          {selectedProvider === undefined ? (
            <SettingsSection
              title={sectionTitle("Global defaults")}
              footer="Individual global changes keep provider overrides. Enable all or Disable all replaces every global and provider choice."
            >
              <SettingsActionRow
                icon="checkmark.circle"
                label="Enable all SSHCode tools"
                disabled={disabled}
                onPress={() => void save(replaceAgentToolPolicy(true))}
              />
              <SettingsActionRow
                icon="xmark.circle.fill"
                label="Disable all SSHCode tools"
                disabled={disabled}
                onPress={() => void save(replaceAgentToolPolicy(false))}
              />
              {visibleTools.map((tool) => {
                const setting = resolveAgentToolSetting(policy, tool.name);
                const overrideCount = countProviderAgentToolOverrides(
                  policy,
                  tool.name,
                  providerIds,
                );
                return (
                  <SettingsSwitchRow
                    key={tool.name}
                    label={tool.title}
                    subtitle={`${agentToolSummary(tool.description)}\n${tool.group}${tool.readonly ? " · Read only" : ""} · ${
                      overrideCount > 0
                        ? `${overrideCount} provider ${overrideCount === 1 ? "override" : "overrides"} take precedence`
                        : "No provider overrides"
                    }`}
                    value={setting.enabled}
                    disabled={disabled}
                    onValueChange={(enabled) =>
                      void save(setGlobalAgentToolEnabled(policy, tool.name, enabled))
                    }
                  />
                );
              })}
            </SettingsSection>
          ) : null}

          {providers
            .filter((provider) => provider === selectedProvider)
            .map((provider) => {
              const providerName = provider.displayName ?? provider.driver;
              const customized = policy.providers[provider.instanceId] !== undefined;
              return (
                <SettingsSection
                  key={provider.instanceId}
                  title={sectionTitle(providerName)}
                  footer="Enable all or Disable all clears individual tool choices for this provider. Reset to global removes its provider default too."
                >
                  <SettingsActionRow
                    icon="checkmark.circle"
                    label={`Enable all for ${providerName}`}
                    disabled={disabled}
                    onPress={() =>
                      void save(setAllProviderAgentToolsEnabled(policy, provider.instanceId, true))
                    }
                  />
                  <SettingsActionRow
                    icon="xmark.circle.fill"
                    label={`Disable all for ${providerName}`}
                    disabled={disabled}
                    onPress={() =>
                      void save(setAllProviderAgentToolsEnabled(policy, provider.instanceId, false))
                    }
                  />
                  <SettingsActionRow
                    icon="arrow.uturn.backward"
                    label="Reset to global defaults"
                    disabled={disabled || !customized}
                    onPress={() => void save(resetProviderAgentTools(policy, provider.instanceId))}
                  />
                  {visibleTools.map((tool) => {
                    const setting = resolveAgentToolSetting(policy, tool.name, provider.instanceId);
                    return (
                      <SettingsSwitchRow
                        key={tool.name}
                        label={tool.title}
                        subtitle={`${agentToolSummary(tool.description)}\n${providerToolSource(policy, tool.name, provider.instanceId)}`}
                        value={setting.enabled}
                        disabled={disabled}
                        onValueChange={(enabled) =>
                          void save(
                            setProviderAgentToolEnabled(
                              policy,
                              provider.instanceId,
                              tool.name,
                              enabled,
                            ),
                          )
                        }
                      />
                    );
                  })}
                </SettingsSection>
              );
            })}
        </>
      )}
    </>
  );
}
