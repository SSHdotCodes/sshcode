import { useWorkflowsEnabled } from "../workflows/state";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useOverviewEnabled } from "../overview/useOverview";
import { SETTINGS_TINT } from "./settingsTints";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions options={{ headerBackVisible: !layout.usesSplitView }} />
      ) : null}
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <>
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="Go back"
              icon="chevron.left"
              onPress={() => navigation.goBack()}
            />
          </NativeHeaderToolbar>
        </>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <SettingsIndexSections
      showNotifications
      accountRow={
        <SettingsRow
          icon="person.crop.circle"
          tint={SETTINGS_TINT.blue}
          label="T3 Account"
          value={accountLabel}
          valuePosition={isSignedIn ? "below" : undefined}
          disabled={!isLoaded}
          onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
        />
      }
    />
  );
}

function LocalSettingsRouteScreen() {
  return <SettingsIndexSections />;
}

/** The Overview prototype's switch; saved on this phone. */
function OverviewSwitchRow() {
  const [enabled, setEnabled] = useOverviewEnabled();
  return (
    <SettingsSwitchRow
      icon={{ ios: "binoculars", android: "visibility" }}
      iconTint={SETTINGS_TINT.red}
      label="Overview"
      subtitle="Prototype: ask what your chats are up to."
      value={enabled}
      onValueChange={setEnabled}
    />
  );
}

function SettingsIndexSections(props: {
  readonly accountRow?: ReactNode;
  readonly showNotifications?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const [workflowsEnabled, setWorkflowsEnabled, canEditWorkflows] = useWorkflowsEnabled(
    selectedTargets.map((target) => target.environmentId),
  );
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4 ios:gap-5"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedProjectKey !== null ? (
          <SettingsSection title="Project">
            <SettingsRow
              icon="folder"
              tint={SETTINGS_TINT.blue}
              label="Overview"
              value={projectLabel}
              valuePosition="below"
              target="SettingsProjectOverview"
            />
          </SettingsSection>
        ) : null}

        <SettingsSection title="Basics" separated>
          <SettingsRow
            icon="paintpalette"
            tint={SETTINGS_TINT.indigo}
            label="Appearance"
            target="SettingsAppearance"
          />
          <SettingsRow
            icon="text.bubble"
            tint={SETTINGS_TINT.blue}
            label="Chats"
            target="SettingsThreads"
          />
          {props.showNotifications ? (
            <SettingsRow
              icon="bell.badge"
              tint={SETTINGS_TINT.red}
              label="Notifications"
              target="SettingsNotifications"
            />
          ) : null}
          {Platform.OS === "ios" ? (
            <SettingsRow
              icon="keyboard"
              tint={SETTINGS_TINT.gray}
              label="Keyboard"
              target="SettingsKeyboard"
            />
          ) : null}
          {Platform.OS === "ios" ? (
            <SettingsRow
              icon="mic"
              tint={SETTINGS_TINT.orange}
              label="Microphone"
              target="SettingsMicrophone"
            />
          ) : null}
          {Platform.OS === "ios" && !Platform.isPad ? (
            <SettingsRow
              icon="slider.horizontal.3"
              tint={SETTINGS_TINT.teal}
              label="Bottom bar"
              target="SettingsStatusAccessory"
            />
          ) : null}
          <SettingsRow
            icon="archivebox"
            tint={SETTINGS_TINT.brown}
            label="Archived chats"
            target="SettingsArchive"
          />
        </SettingsSection>

        <SettingsSection title="Agents & models" separated>
          <SettingsRow
            icon="text.bubble"
            tint={SETTINGS_TINT.green}
            label="New chats"
            target="SettingsEnvironmentNewThreads"
            disabled={noServerTargets}
          />
          <SettingsRow
            icon="person.crop.circle"
            tint={SETTINGS_TINT.cyan}
            label="Provider accounts"
            target="SettingsProviderAccounts"
            disabled={noServerTargets}
          />
          <SettingsRow
            icon="star"
            tint={SETTINGS_TINT.yellow}
            label="Model family rankings"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsModelRankings" },
              })
            }
            disabled={noServerTargets}
          />
          <SettingsRow
            icon="hammer"
            tint={SETTINGS_TINT.graphite}
            label="Tools"
            disabled={noServerTargets}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsTools" },
              })
            }
          />
          <SettingsRow
            icon="sparkles"
            tint={SETTINGS_TINT.purple}
            label="Skills"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsSkills" },
              })
            }
          />
          <SettingsRow
            icon="desktopcomputer"
            tint={SETTINGS_TINT.indigo}
            label="Computer use"
            disabled={noServerTargets}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsComputerUse" },
              })
            }
          />
          <SettingsRow
            icon="text.alignleft"
            tint={SETTINGS_TINT.orange}
            label="Agent behavior"
            target="SettingsEnvironmentAgentBehavior"
            disabled={noServerTargets}
          />
          <SettingsRow
            icon="clock"
            tint={SETTINGS_TINT.pink}
            label="Scheduled tasks"
            target="SettingsScheduledTasks"
          />
        </SettingsSection>

        <SettingsSection title="Machines" separated>
          {props.accountRow}
          <SettingsRow
            icon="desktopcomputer"
            tint={SETTINGS_TINT.blue}
            label="Environments"
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow
            icon="arrow.clockwise"
            tint={SETTINGS_TINT.gray}
            label="Maintenance"
            target="SettingsEnvironmentMaintenance"
            disabled={noServerTargets}
          />
        </SettingsSection>

        <SettingsSection title="Integrations">
          <SettingsRow
            icon="arrow.triangle.branch"
            tint={SETTINGS_TINT.orange}
            label="Source control"
            target="SettingsEnvironmentSourceControl"
            disabled={noServerTargets}
          />
        </SettingsSection>

        <SettingsSection title="More" separated>
          <OverviewSwitchRow />
          <SettingsSwitchRow
            icon="arrow.triangle.branch"
            iconTint={SETTINGS_TINT.teal}
            label="Workflows (beta)"
            subtitle="Draw a team of agents and follow its work."
            value={workflowsEnabled}
            disabled={!canEditWorkflows || selectedProjectKey !== null}
            onValueChange={setWorkflowsEnabled}
          />
          <SettingsRow
            icon="checklist"
            tint={SETTINGS_TINT.yellow}
            label="Notes"
            target="SettingsNotes"
          />
          <SettingsRow
            icon="chart.bar.xaxis"
            tint={SETTINGS_TINT.green}
            label="Usage"
            target="SettingsUsage"
          />
          <SettingsRow
            icon="info.circle"
            tint={SETTINGS_TINT.gray}
            label="About SSHCode"
            target="SettingsAbout"
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
