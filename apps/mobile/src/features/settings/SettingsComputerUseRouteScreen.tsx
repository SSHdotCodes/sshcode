import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { computerUseEnvironment, serverEnvironment } from "../../state/server";
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

type PendingAction = "settings" | "refresh" | "setup" | "resume";
type ComputerUseRouteParams = { readonly environmentId?: EnvironmentId } | undefined;

function commandError(
  result: Extract<Parameters<typeof isAtomCommandInterrupted>[0], { _tag: "Failure" }>,
) {
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The computer-use request failed.";
}

export function SettingsComputerUseRouteScreen({
  route,
}: StaticScreenProps<ComputerUseRouteParams>) {
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const environmentId = route.params?.environmentId;
  const targets = environmentId
    ? availableTargets.filter((target) => target.environmentId === environmentId)
    : selectedTargets;

  return (
    <>
      {environmentId === undefined ? <SettingsEnvironmentFilterHeader /> : null}
      <SettingsScreen
        title="Computer use"
        trailing={environmentId === undefined ? <AndroidSettingsEnvironmentFilter /> : undefined}
      >
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
            Let agents use apps with mouse and keyboard input. One environment opt-in covers
            instructed tasks across providers, without per-app or per-action approval cards.
          </Text>
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Select a connected environment.
            </Text>
          ) : (
            targets.map((environment) => (
              <ComputerUseEnvironmentSettings
                key={environment.environmentId}
                environment={environment}
                showEnvironmentLabel={targets.length > 1}
              />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ComputerUseEnvironmentSettings({
  environment,
  showEnvironmentLabel,
}: {
  readonly environment: SettingsTarget;
  readonly showEnvironmentLabel: boolean;
}) {
  const environmentId = environment.environmentId;
  const supported = environment.serverConfig.computerUse === true;
  const initialSettings = environment.serverConfig.settings.computerUse;
  const query = useEnvironmentQuery(
    supported ? computerUseEnvironment.state({ environmentId, input: {} }) : null,
  );
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
  const sectionTitle = useCallback(
    (title: string) => (showEnvironmentLabel ? `${environment.label} · ${title}` : title),
    [environment.label, showEnvironmentLabel],
  );

  const runAction = useCallback(
    async (action: Exclude<PendingAction, "settings">) => {
      if (!supported) return;
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
    [coordinator, environmentId, query.data, refresh, resume, setup, supported],
  );

  const takeControl = useCallback(async () => {
    if (!supported || !settings.enabled || !canStop) return;
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
  }, [canStop, coordinator, environmentId, query.data, settings.enabled, stop, supported]);

  const saveSettings = useCallback(
    async (nextSettings: ComputerUseSettings) => {
      if (!canWrite || !supported) return;
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
    [
      canWrite,
      coordinator,
      environmentId,
      initialSettings,
      query.data,
      refresh,
      supported,
      updateSettings,
    ],
  );

  useEffect(() => {
    if (
      busy ||
      !supported ||
      !status ||
      !settings.enabled ||
      status.paused ||
      checkedInitialStatus.current
    )
      return;
    checkedInitialStatus.current = true;
    void runAction("refresh");
  }, [busy, runAction, settings.enabled, status, supported]);

  if (!supported) {
    return (
      <SettingsSection title={sectionTitle("Computer use")}>
        <ListRowLayout
          icon="desktopcomputer"
          label="Update this environment to use computer control"
          description="This host does not support Computer use settings yet. No request was sent to the older host."
        />
      </SettingsSection>
    );
  }

  const setupSummary = status ? computerUseSetupSummary(status.driver, status.supported) : null;
  const platform = status?.driver.platform === "darwin" ? "macOS" : status?.driver.platform;

  return (
    <>
      <SettingsSection title={sectionTitle("Computer use")}>
        <SettingsSwitchRow
          icon="desktopcomputer"
          label="Enable Computer use"
          subtitle="Allow agents to control apps on this environment. Off by default."
          value={settings.enabled}
          disabled={busy || !canWrite || status?.supported === false}
          onValueChange={(enabled) => void saveSettings({ ...settings, enabled })}
        />
      </SettingsSection>

      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {query.error ? (
        <SettingsSection title={sectionTitle("Status")}>
          <ListRowLayout
            icon="exclamationmark.triangle"
            label="Could not load computer-use status"
            description={query.error}
          />
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Retry"
            disabled={busy}
            onPress={() => void runAction("refresh")}
          />
        </SettingsSection>
      ) : null}

      {!status && query.isPending ? (
        <SettingsSection title={sectionTitle("Status")}>
          <View className="items-center gap-3 px-6 py-8">
            <AppActivityIndicator />
            <Text className="text-sm text-foreground-muted">Loading computer-use status…</Text>
          </View>
        </SettingsSection>
      ) : status ? (
        <>
          <SettingsSection title={sectionTitle("Status")}>
            <SettingsActionRow
              icon="arrow.clockwise"
              label={pending === "refresh" ? "Refreshing…" : "Refresh status"}
              loading={pending === "refresh"}
              disabled={busy}
              onPress={() => void runAction("refresh")}
            />
            <ListRowLayout
              icon="desktopcomputer"
              label="Driver"
              description={`${platform} · ${status.driver.installed ? "Installed" : "Not installed"}`}
              detail={computerUseAvailabilityLabel(status)}
            />
            <ListRowLayout
              icon="gearshape"
              label="OS permissions"
              description={
                setupSummary ?? "Accessibility and Screen Recording are available to the driver."
              }
            />
            {!status.driver.installed && status.supported ? (
              <SettingsActionRow
                icon="gearshape"
                label={pending === "setup" ? "Setting up…" : "Set up computer use"}
                loading={pending === "setup"}
                disabled={busy || !canSetup}
                onPress={() => void runAction("setup")}
              />
            ) : null}
            <ListRowLayout
              icon="desktopcomputer"
              label="Active controller"
              description={computerUseControllerSummary(status)}
              detail={status.paused ? "You" : status.owner ? "Agent" : "Idle"}
            />
            <SettingsActionRow
              icon={status.paused ? "play" : "stop.fill"}
              label={
                stopPending
                  ? "Taking control…"
                  : pending === "resume"
                    ? "Resuming…"
                    : status.paused
                      ? "Resume agent access"
                      : "Take control"
              }
              loading={stopPending || pending === "resume"}
              disabled={
                !settings.enabled ||
                (status.paused ? busy || stopPending || !canResume : stopPending || !canStop)
              }
              onPress={() => void (status.paused ? runAction("resume") : takeControl())}
            />
          </SettingsSection>

          <SettingsSection
            title={sectionTitle("App access")}
            footer="Optional bundle or application identifiers, one per line. Leave empty to allow every app. Take control stops and revokes all agent mouse and keyboard input until you resume it."
          >
            <View className="px-4 py-3">
              <TextInput
                accessibilityLabel="Blocked app identifiers"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy && canWrite}
                multiline
                className="min-h-24 rounded-2xl border border-border-subtle bg-grouped-card px-4 py-3 text-base text-foreground"
                placeholder={"com.example.App\ncom.example.OtherApp"}
                placeholderTextColorClassName="accent-placeholder"
                value={blockedDraft}
                onChangeText={(value) => setBlockedEdit({ baseKey: blockedKey, value })}
              />
            </View>
            <SettingsActionRow
              icon="checkmark.circle"
              label="Save blocked apps"
              disabled={busy || !canWrite || !blockedDirty}
              onPress={() =>
                void saveSettings({
                  ...settings,
                  blockedAppIds: parseBlockedAppIds(blockedDraft),
                })
              }
            />
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
