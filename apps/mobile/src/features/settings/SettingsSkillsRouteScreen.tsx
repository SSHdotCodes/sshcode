import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SharedSkill, SharedSkillsCommand } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment } from "../../state/server";
import { useSharedSkillsCatalog } from "../../state/useSharedSkills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

function commandError(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : "Could not update skills.";
}

export function SettingsSkillsRouteScreen(_props: StaticScreenProps<undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environment = selectedTargets[0] ?? null;
  const environmentId: EnvironmentId | null = environment?.environmentId ?? null;
  const catalog = useSharedSkillsCatalog(environmentId);
  const run = useAtomCommand(serverEnvironment.sharedSkillsCommand, { reportFailure: false });
  const [folderPath, setFolderPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const command = async (input: SharedSkillsCommand): Promise<boolean> => {
    if (environmentId === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const message = commandError(await run({ environmentId, input }));
      if (message) {
        setError(message);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const remove = (skill: SharedSkill) => {
    const title = "Remove skill?";
    const message = `Remove ${skill.name} from the shared library?`;
    const go = () => {
      void command({ type: "remove", name: skill.name });
    };
    if (Platform.OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: go },
      ]);
      return;
    }
    showConfirmDialog({
      title,
      message,
      confirmText: "Remove",
      destructive: true,
      onConfirm: go,
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Skills" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          {selectedTargets.length > 1
            ? `Skills are stored on each machine. This list is from ${environment?.label ?? "the first selected machine"}.`
            : "Installed once, then shared with the agents SSHCode runs."}
        </Text>
        <SettingsSection title="Library">
          {environmentId === null ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              Connect a machine to manage skills.
            </Text>
          ) : catalog === null ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              Reading the shared library.
            </Text>
          ) : catalog.skills.length === 0 ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              No skills yet. Add a folder that contains SKILL.md, or a Git URL.
            </Text>
          ) : (
            catalog.skills.map((skill) => (
              <View key={skill.directoryName}>
                <SettingsSwitchRow
                  icon="sparkles"
                  label={skill.name}
                  subtitle={[skill.description, skill.origin, skill.harnesses]
                    .filter((part) => part && part.length > 0)
                    .join(" ")}
                  value={skill.enabled}
                  disabled={busy}
                  onValueChange={(enabled) =>
                    void command({ type: "setSharing", name: skill.name, enabled })
                  }
                />
                {skill.canUpdate || skill.canRemove ? (
                  <View className="flex-row gap-3 px-4 pb-3">
                    {skill.canUpdate ? (
                      <Pressable
                        style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => void command({ type: "update", name: skill.name })}
                      >
                        <Text className="text-sm text-foreground">Update</Text>
                      </Pressable>
                    ) : null}
                    {skill.canRemove ? (
                      <Pressable
                        style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => remove(skill)}
                      >
                        <Text className="text-sm text-danger-foreground">Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))
          )}
        </SettingsSection>
        {environmentId === null ? null : (
          <SettingsSection title="Add">
            <View className="gap-3 p-4">
              <AppTextInput
                accessibilityLabel="Skill folder path"
                className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
                value={folderPath}
                onChangeText={setFolderPath}
                placeholder="Folder path"
                editable={!busy}
              />
              <Pressable
                style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
                accessibilityRole="button"
                disabled={busy || folderPath.trim().length === 0}
                onPress={() => {
                  const path = folderPath.trim();
                  if (path.length === 0) return;
                  void command({ type: "addFolder", path }).then((added) => {
                    if (added) setFolderPath("");
                  });
                }}
              >
                <Text className="text-sm text-foreground">Add folder</Text>
              </Pressable>
              <AppTextInput
                accessibilityLabel="Git URL"
                className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
                value={gitUrl}
                onChangeText={setGitUrl}
                placeholder="https:// or git@"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <Pressable
                style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
                accessibilityRole="button"
                disabled={busy || gitUrl.trim().length === 0}
                onPress={() => {
                  const url = gitUrl.trim();
                  if (url.length === 0) return;
                  void command({ type: "addGit", url }).then((added) => {
                    if (added) setGitUrl("");
                  });
                }}
              >
                <Text className="text-sm text-foreground">Add Git URL</Text>
              </Pressable>
              {error ? <Text className="text-sm text-foreground-muted">{error}</Text> : null}
            </View>
          </SettingsSection>
        )}
      </ScrollView>
    </View>
  );
}
