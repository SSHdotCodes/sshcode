import { useAtomValue } from "@effect/atom-react";
import {
  computerUseAvailabilityLabel,
  computerUseControllerSummary,
  computerUseSetupSummary,
  createComputerUseCommandCoordinator,
  formatBlockedAppIds,
  parseBlockedAppIds,
} from "@t3tools/client-runtime/state/computer-use";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseSettings, ComputerUseStatus, EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { computerUseEnvironment, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ListState } from "../ui/list-state";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type PendingAction = "settings" | "refresh" | "setup" | "resume";

function commandError(
  result: Extract<Parameters<typeof isAtomCommandInterrupted>[0], { _tag: "Failure" }>,
) {
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The computer-use request failed.";
}

export function ComputerUseSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  if (!environment?.serverConfig) {
    return (
      <SettingsPageContainer>
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to manage computer use.`
            : "Connect an environment to manage computer use."}
        </p>
      </SettingsPageContainer>
    );
  }
  if (environment.serverConfig.computerUse !== true) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("computer-use")}>
          <ListState
            title="Update this environment to use computer control"
            description="This host does not support Computer use settings yet. No request was sent to the older host."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <ComputerUseEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      initialSettings={environment.serverConfig.settings.computerUse}
    />
  );
}

function ComputerUseEnvironmentSettings({
  environmentId,
  initialSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialSettings: ComputerUseSettings;
}) {
  const query = useEnvironmentQuery(computerUseEnvironment.state({ environmentId, input: {} }));
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canSetup = useAtomValue(computerUseEnvironment.setup.permissionAtom(environmentId));
  const canStop = useAtomValue(computerUseEnvironment.stop.permissionAtom(environmentId));
  const canResume = useAtomValue(computerUseEnvironment.resume.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "computer use settings update",
    reportFailure: false,
  });
  const refresh = useAtomCommand(computerUseEnvironment.refresh, {
    label: "refresh computer use",
    reportFailure: false,
  });
  const setup = useAtomCommand(computerUseEnvironment.setup, {
    label: "set up computer use",
    reportFailure: false,
  });
  const stop = useAtomCommand(computerUseEnvironment.stop, {
    label: "take computer control",
    reportFailure: false,
  });
  const resume = useAtomCommand(computerUseEnvironment.resume, {
    label: "resume computer control",
    reportFailure: false,
  });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{
    readonly base: ComputerUseStatus | null;
    readonly value: ComputerUseStatus;
  } | null>(null);
  const [optimisticSettings, setOptimisticSettings] = useState<{
    readonly baseStatus: ComputerUseStatus | null;
    readonly baseInitial: ComputerUseSettings;
    readonly value: ComputerUseSettings;
  } | null>(null);
  const [blockedEdit, setBlockedEdit] = useState<{
    readonly baseKey: string;
    readonly value: string;
  } | null>(null);
  const coordinator = useRef(createComputerUseCommandCoordinator()).current;
  const checkedInitialStatus = useRef(false);
  const status = actionResult?.base === query.data ? actionResult.value : query.data;
  const settings =
    optimisticSettings?.baseStatus === query.data &&
    optimisticSettings.baseInitial === initialSettings
      ? optimisticSettings.value
      : {
          enabled: status?.enabled ?? initialSettings.enabled,
          blockedAppIds: status?.blockedAppIds ?? initialSettings.blockedAppIds,
        };
  const blockedKey = formatBlockedAppIds(settings.blockedAppIds);
  const blockedDraft = blockedEdit?.baseKey === blockedKey ? blockedEdit.value : blockedKey;
  const blockedDraftKey = formatBlockedAppIds(parseBlockedAppIds(blockedDraft));
  const blockedDirty = blockedDraftKey !== blockedKey;
  const busy = pending !== null || stopPending;

  const runAction = useCallback(
    async (action: Exclude<PendingAction, "settings">) => {
      const epoch = coordinator.beginOrdinary();
      if (epoch === null) return;
      setPending(action);
      setError(null);
      try {
        const target = { environmentId, input: {} };
        const result =
          action === "refresh"
            ? await refresh(target)
            : action === "setup"
              ? await setup(target)
              : await resume(target);
        if (!coordinator.isCurrent(epoch)) return;
        if (result._tag === "Success") {
          setActionResult({ base: query.data, value: result.value });
        } else {
          setError(commandError(result));
        }
      } catch (cause) {
        if (coordinator.isCurrent(epoch)) {
          setError(cause instanceof Error ? cause.message : "The computer-use request failed.");
        }
      } finally {
        coordinator.endOrdinary();
        setPending(null);
      }
    },
    [coordinator, environmentId, query.data, refresh, resume, setup],
  );

  const takeControl = useCallback(async () => {
    if (!settings.enabled || !canStop) return;
    const epoch = coordinator.beginStop();
    if (epoch === null) return;
    setStopPending(true);
    setError(null);
    try {
      const result = await stop({ environmentId, input: {} });
      if (!coordinator.isCurrent(epoch)) return;
      if (result._tag === "Success") {
        setActionResult({ base: query.data, value: result.value });
      } else {
        setError(commandError(result));
      }
    } catch (cause) {
      if (coordinator.isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "The computer-use request failed.");
      }
    } finally {
      coordinator.endStop();
      setStopPending(false);
    }
  }, [canStop, coordinator, environmentId, query.data, settings.enabled, stop]);

  const saveSettings = useCallback(
    async (nextSettings: ComputerUseSettings) => {
      if (!canWrite) return;
      const epoch = coordinator.beginOrdinary();
      if (epoch === null) return;
      setPending("settings");
      setError(null);
      const optimistic = {
        baseStatus: query.data,
        baseInitial: initialSettings,
      };
      setOptimisticSettings({ ...optimistic, value: nextSettings });
      try {
        const result = await updateSettings({
          environmentId,
          input: { patch: { computerUse: nextSettings } },
        });
        if (result._tag === "Failure") {
          if (coordinator.isCurrent(epoch)) {
            setOptimisticSettings(null);
            setError(commandError(result));
          }
          return;
        }
        if (!coordinator.isCurrent(epoch)) return;
        setOptimisticSettings({ ...optimistic, value: result.value.computerUse });
        const refreshed = await refresh({ environmentId, input: {} });
        if (!coordinator.isCurrent(epoch)) return;
        if (refreshed._tag === "Success") {
          setActionResult({ base: query.data, value: refreshed.value });
          setOptimisticSettings(null);
        }
      } catch (cause) {
        if (coordinator.isCurrent(epoch)) {
          setOptimisticSettings(null);
          setError(
            cause instanceof Error ? cause.message : "Computer use settings were not saved.",
          );
        }
      } finally {
        coordinator.endOrdinary();
        setPending(null);
      }
    },
    [canWrite, coordinator, environmentId, initialSettings, query.data, refresh, updateSettings],
  );

  useEffect(() => {
    if (busy || !status || !settings.enabled || status.paused || checkedInitialStatus.current)
      return;
    checkedInitialStatus.current = true;
    void runAction("refresh");
  }, [busy, runAction, settings.enabled, status]);

  const setupSummary = status ? computerUseSetupSummary(status.driver, status.supported) : null;
  const platform = status?.driver.platform === "darwin" ? "macOS" : status?.driver.platform;

  return (
    <SettingsPageContainer>
      <p className="max-w-2xl px-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
        Let agents use apps on this environment with mouse and keyboard input. One environment
        opt-in covers instructed tasks across providers, without per-app or per-action approval
        cards.
      </p>

      <SettingsSection {...searchableSetting("computer-use")}>
        <SettingsRow
          title="Enable Computer use"
          description="Allow agents to control apps on this environment. It is off by default and can be turned off at any time."
          control={
            <Switch
              aria-label="Enable Computer use"
              checked={settings.enabled}
              disabled={busy || !canWrite || status?.supported === false}
              onCheckedChange={(enabled) =>
                void saveSettings({ ...settings, enabled: Boolean(enabled) })
              }
            />
          }
        />
      </SettingsSection>

      {error ? (
        <p role="alert" className="px-3 text-xs text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {query.error ? (
        <div className="mx-3 flex items-center justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:mx-4">
          <span>Could not load computer-use status: {query.error}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void runAction("refresh")}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {!status && query.isPending ? (
        <SettingsSection title="Status">
          <ListState loading title="Loading computer-use status" />
        </SettingsSection>
      ) : status ? (
        <>
          <SettingsSection
            title="Status"
            headerAction={
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void runAction("refresh")}
              >
                <RefreshCwIcon />
                {pending === "refresh" ? "Refreshing…" : "Refresh"}
              </Button>
            }
          >
            <SettingsRow
              title="Driver"
              description={`${platform} · ${status.driver.installed ? "Installed" : "Not installed"}`}
              status={computerUseAvailabilityLabel(status)}
            />
            <SettingsRow
              title="OS permissions"
              description={
                setupSummary ?? "Accessibility and Screen Recording are available to the driver."
              }
              control={
                !status.driver.installed && status.supported ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !canSetup}
                    onClick={() => void runAction("setup")}
                  >
                    {pending === "setup" ? "Setting up…" : "Set up"}
                  </Button>
                ) : undefined
              }
            />
            <SettingsRow
              title="Active controller"
              description={computerUseControllerSummary(status)}
              status={
                status.paused ? "You have control" : status.owner ? "Agent has control" : "Idle"
              }
            />
            <SettingsRow
              title="Agent input"
              description="Take control to stop and revoke all agent mouse and keyboard input. Resume when agents may continue."
              control={
                <Button
                  size="sm"
                  variant={status.paused ? "default" : "outline"}
                  disabled={
                    !settings.enabled ||
                    (status.paused ? busy || stopPending || !canResume : stopPending || !canStop)
                  }
                  onClick={() => void (status.paused ? runAction("resume") : takeControl())}
                >
                  {stopPending
                    ? "Taking control…"
                    : pending === "resume"
                      ? "Resuming…"
                      : status.paused
                        ? "Resume agent access"
                        : "Take control"}
                </Button>
              }
            />
          </SettingsSection>

          <SettingsSection title="App access">
            <SettingsRow
              title="Blocked app identifiers"
              description="Optional bundle or application identifiers, one per line. Leave empty to allow every app."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canWrite || !blockedDirty}
                  onClick={() =>
                    void saveSettings({
                      ...settings,
                      blockedAppIds: parseBlockedAppIds(blockedDraft),
                    })
                  }
                >
                  Save
                </Button>
              }
            >
              <div className="px-0 pb-2 pt-2">
                <Textarea
                  aria-label="Blocked app identifiers"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy || !canWrite}
                  placeholder={"com.example.App\ncom.example.OtherApp"}
                  value={blockedDraft}
                  onChange={(event) =>
                    setBlockedEdit({ baseKey: blockedKey, value: event.currentTarget.value })
                  }
                />
              </div>
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
