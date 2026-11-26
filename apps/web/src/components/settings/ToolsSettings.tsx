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
import type {
  AgentToolPolicy,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { agentToolsEnvironment, serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ListState } from "../ui/list-state";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SharedSkillsSettings } from "./SharedSkillsSettings";

/** `state` greys out the button that would change nothing, so a long list reads at a glance. */
function BulkToolActions({
  label,
  disabled,
  state,
  onChange,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly state?: "all" | "none" | "some";
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || state === "all"}
        onClick={() => onChange(true)}
        aria-label={`Enable all ${label}`}
      >
        Enable all
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || state === "none"}
        onClick={() => onChange(false)}
        aria-label={`Disable all ${label}`}
      >
        Disable all
      </Button>
    </div>
  );
}

function providerToolSource(policy: AgentToolPolicy, tool: string, provider: ProviderInstanceId) {
  const setting = resolveAgentToolSetting(policy, tool, provider);
  switch (setting.source) {
    case "provider-tool":
      return `Custom for this provider. The global default is ${resolveAgentToolSetting(policy, tool).enabled ? "on" : "off"}.`;
    case "provider-default":
      return `Uses this provider's ${setting.enabled ? "on" : "off"} default. Reset the provider to inherit global settings.`;
    case "global-tool":
      return `Inherited from the global ${setting.enabled ? "on" : "off"} setting.`;
    case "global-default":
      return `Inherited from the global ${setting.enabled ? "on" : "off"} default.`;
  }
}

/** Skills & tools: the shared skill library, then which SSHCode tools agents get. */
export function ToolsSettingsPanel() {
  const { environment, scope, connectedEnvironments } = useSettingsScope();
  const skills = (
    <SharedSkillsSettings
      environmentId={environment?.environmentId ?? null}
      environmentLabel={environment?.label ?? null}
      showMachineNote={connectedEnvironments.length > 1}
    />
  );
  if (!environment?.serverConfig) {
    return (
      <SettingsPageContainer>
        {skills}
        <SettingsSection title="Tools">
          <ListState
            size="compact"
            title="No environment connected"
            description={
              scope.kind === "environment"
                ? `Reconnect ${scope.label} to manage its tools.`
                : "Connect an environment to manage its tools."
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <ToolsEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      providers={environment.serverConfig.providers}
      supported={environment.serverConfig.agentToolsSettings === true}
      skills={skills}
    />
  );
}

function ToolsEnvironmentSettings({
  environmentId,
  providers,
  supported,
  skills,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly supported: boolean;
  readonly skills: ReactNode;
}) {
  const query = useEnvironmentQuery(
    supported ? agentToolsEnvironment.state({ environmentId, input: {} }) : null,
  );
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agent tool settings update",
    reportFailure: false,
  });
  const [search, setSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const selectedProvider = providers.find((provider) => provider.instanceId === selectedProviderId);
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
      <SettingsPageContainer>
        {skills}
        <SettingsSection {...searchableSetting("tools")}>
          <ListState
            title="Update this environment to manage tools"
            description="This host does not support SSHCode tool settings yet. No request was sent to the older host."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {skills}
      <div className="space-y-3 px-3 sm:px-4">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Control tools provided by SSHCode. Provider-native CLI tools and external plugin tools are
          not affected. Provider choices override global defaults.
        </p>
        <div className="flex flex-wrap gap-2">
          <Select
            value={selectedProvider?.instanceId ?? ""}
            onValueChange={(value) => setSelectedProviderId(value ?? "")}
          >
            <SelectTrigger className="w-full sm:w-72" aria-label="Tool settings provider">
              <SelectValue>
                {selectedProvider?.displayName ??
                  selectedProvider?.driver ??
                  "All providers · Global defaults"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All providers · Global defaults</SelectItem>
              {providers.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.driver}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search tools"
            aria-label="Search SSHCode tools"
            className="min-w-48 flex-1"
          />
        </div>
      </div>

      {query.error ? (
        <div
          role="alert"
          className="mx-3 flex items-center justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:mx-4"
        >
          <span>Could not load the tool catalog: {query.error}</span>
          <Button size="xs" variant="outline" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : null}
      {saveError ? (
        <p role="alert" className="px-3 text-xs text-destructive sm:px-4">
          Tool settings were not saved: {saveError}
        </p>
      ) : null}
      {!canWrite ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          This connection has read-only access. Ask for settings write permission to change tools.
        </p>
      ) : null}

      {!state && query.isPending ? (
        <SettingsSection title="Tools">
          <ListState
            loading
            title="Loading SSHCode tools"
            description="Loading the tool catalog."
          />
        </SettingsSection>
      ) : !state ? null : policy === undefined ? null : (
        <>
          <SettingsSection {...searchableSetting("tools")} title="Tool groups">
            {Array.from(groups)
              .filter(([, tools]) => tools.some((tool) => visibleTools.includes(tool)))
              .map(([group, tools]) => {
                const enabledCount = tools.filter(
                  (tool) =>
                    resolveAgentToolSetting(policy, tool.name, selectedProvider?.instanceId)
                      .enabled,
                ).length;
                return (
                  <SettingsRow
                    key={group}
                    title={group.slice(0, 1).toUpperCase() + group.slice(1)}
                    description={`${enabledCount} of ${tools.length} enabled. ${selectedProvider ? "Applies to this provider." : "Global defaults; provider overrides still apply."}`}
                    control={
                      <BulkToolActions
                        label={`${group} tools`}
                        disabled={disabled}
                        // A provider row can still pin an inherited value, so only global rows go inert.
                        state={
                          selectedProvider !== undefined
                            ? "some"
                            : enabledCount === tools.length
                              ? "all"
                              : enabledCount === 0
                                ? "none"
                                : "some"
                        }
                        onChange={(enabled) =>
                          void save(
                            setAgentToolGroupEnabled(
                              policy,
                              tools,
                              enabled,
                              selectedProvider?.instanceId,
                            ),
                          )
                        }
                      />
                    }
                  />
                );
              })}
          </SettingsSection>
          {selectedProvider === undefined ? (
            <SettingsSection title="Global defaults">
              <SettingsRow
                title="All SSHCode tools"
                description="Set every global default and clear all provider overrides. Individual global changes keep provider overrides."
                control={
                  <BulkToolActions
                    label="SSHCode tools globally"
                    disabled={disabled}
                    onChange={(enabled) => void save(replaceAgentToolPolicy(enabled))}
                  />
                }
              />
              {visibleTools.map((tool) => {
                const setting = resolveAgentToolSetting(policy, tool.name);
                const overrideCount = countProviderAgentToolOverrides(
                  policy,
                  tool.name,
                  providerIds,
                );
                return (
                  <SettingsRow
                    key={tool.name}
                    title={tool.title}
                    description={agentToolSummary(tool.description)}
                    status={
                      <>
                        {tool.group}
                        {tool.readonly ? " · Read only" : ""}
                        {overrideCount > 0
                          ? ` · ${overrideCount} provider ${overrideCount === 1 ? "override" : "overrides"} take precedence`
                          : " · No provider overrides"}
                      </>
                    }
                    control={
                      <Switch
                        aria-label={`Global default: ${tool.title}`}
                        checked={setting.enabled}
                        disabled={disabled}
                        onCheckedChange={(enabled) =>
                          void save(setGlobalAgentToolEnabled(policy, tool.name, Boolean(enabled)))
                        }
                      />
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
                  title={providerName}
                  id={`tools-provider-${provider.instanceId}`}
                  headerAction={
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={disabled || !customized}
                      onClick={() =>
                        void save(resetProviderAgentTools(policy, provider.instanceId))
                      }
                    >
                      Reset to global
                    </Button>
                  }
                >
                  <SettingsRow
                    title={`All tools for ${providerName}`}
                    description="Set one default for this provider and clear its individual tool choices. Reset to global removes the provider default too."
                    control={
                      <BulkToolActions
                        label={`tools for ${providerName}`}
                        disabled={disabled}
                        onChange={(enabled) =>
                          void save(
                            setAllProviderAgentToolsEnabled(policy, provider.instanceId, enabled),
                          )
                        }
                      />
                    }
                  />
                  {visibleTools.map((tool) => {
                    const setting = resolveAgentToolSetting(policy, tool.name, provider.instanceId);
                    return (
                      <SettingsRow
                        key={tool.name}
                        title={tool.title}
                        description={agentToolSummary(tool.description)}
                        status={providerToolSource(policy, tool.name, provider.instanceId)}
                        control={
                          <Switch
                            aria-label={`${providerName}: ${tool.title}`}
                            checked={setting.enabled}
                            disabled={disabled}
                            onCheckedChange={(enabled) =>
                              void save(
                                setProviderAgentToolEnabled(
                                  policy,
                                  provider.instanceId,
                                  tool.name,
                                  Boolean(enabled),
                                ),
                              )
                            }
                          />
                        }
                      />
                    );
                  })}
                </SettingsSection>
              );
            })}
          {visibleTools.length === 0 ? (
            <SettingsSection title="Search results">
              <ListState
                title="No tools found"
                description="Try a tool name, description, or group."
                align="center"
              />
            </SettingsSection>
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}
