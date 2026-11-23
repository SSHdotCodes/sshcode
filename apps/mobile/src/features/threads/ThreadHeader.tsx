import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useUiMode } from "../discord/useUiMode";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import { filterThreadHeaderItems } from "../../lib/threadHeaderItems";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useComputerUseStatus } from "../computer-use/useComputerUseStatus";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceListNavigation } from "../workspace/useAndroidWorkspaceNavigation";

export function ThreadHeader(
  props: Omit<Parameters<typeof useThreadHeaderOptions>[0], "headerColor"> & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const [uiMode] = useUiMode();
  const navigation = useNavigation();
  const returnToList = useWorkspaceListNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const { hasHarnessTheme, themeVariables, themeAppearance } = useAppearancePreferences();
  const computerUseStatus = useComputerUseStatus(
    EnvironmentId.make(props.gitControls.environmentId),
    ThreadId.make(props.gitControls.threadId),
  );
  const native = useThreadHeaderOptions({
    ...props,
    headerColor: themeVariables["--color-header"],
  });
  const { visibleHeaderItems } = native;
  const androidHeaderActions = useMemo<ReadonlyArray<ScreenHeaderAction>>(() => {
    const actions: ScreenHeaderAction[] = [];
    if (computerUseStatus)
      actions.push({
        accessibilityLabel: computerUseStatus.label,
        icon: computerUseStatus.icon,
        selected: computerUseStatus.selected,
        onPress: computerUseStatus.openSettings,
      });
    if (props.onOpenMedia)
      actions.push({
        accessibilityLabel: "Media",
        icon: "photo",
        onPress: props.onOpenMedia,
      });
    if (uiMode === "discord")
      actions.push({
        accessibilityLabel: "Members",
        icon: "person.2",
        onPress: () =>
          navigation.navigate("ThreadAgents", {
            environmentId: EnvironmentId.make(props.gitControls.environmentId),
            threadId: ThreadId.make(props.gitControls.threadId),
          }),
      });
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
    actions.push(
      ...filterThreadHeaderItems<ScreenHeaderAction>(
        [
          [
            "files",
            props.hasThreadCwd
              ? {
                  accessibilityLabel: filesVisible ? "Close files" : "Open files",
                  selected: filesVisible,
                  icon: "folder",
                  onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
                }
              : null,
          ],
          [
            "terminal",
            props.hasWorkspaceRoot && props.gitControls.canOpenTerminal
              ? {
                  accessibilityLabel: "Open terminal",
                  icon: "terminal",
                  onPress: () => onOpenTerminal(null),
                }
              : null,
          ],
          [
            "sideChat",
            props.sideChat
              ? {
                  accessibilityLabel: props.sideChat.label,
                  icon: "bubble.left.and.bubble.right",
                  onPress: props.sideChat.onOpen,
                }
              : null,
          ],
          [
            "git",
            {
              accessibilityLabel: "Open git controls",
              icon: "point.topleft.down.curvedto.point.bottomright.up",
              onPress: props.onOpenGitInspector,
            },
          ],
        ],
        visibleHeaderItems,
      ),
    );
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: "arrow.triangle.merge",
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    computerUseStatus,
    uiMode,
    navigation,
    props.gitControls.environmentId,
    props.gitControls.threadId,
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
    props.sideChat,
    props.onOpenMedia,
    visibleHeaderItems,
  ]);

  return (
    <>
      <ScreenHeader
        title={privateLabel("Chat", props.gitControls.threadId, props.title)}
        subtitle={privacy ? "Details hidden" : props.subtitle}
        sidebar={native.sidebar}
        options={{
          ...native.options,
          headerStyle: hasHarnessTheme
            ? { backgroundColor: themeVariables["--color-header"] }
            : undefined,
          headerTintColor: hasHarnessTheme
            ? themeVariables["--color-header-foreground"]
            : undefined,
          headerTitleStyle: hasHarnessTheme
            ? {
                ...native.options.headerTitleStyle,
                color: themeVariables["--color-header-foreground"],
              }
            : native.options.headerTitleStyle,
          statusBarStyle: themeAppearance === "dark" ? "light" : "dark",
          contentStyle: hasHarnessTheme
            ? { backgroundColor: themeVariables["--color-screen"] }
            : undefined,
        }}
        optionsVersion={native.optionsVersion}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={layout.usesSplitView ? undefined : returnToList}
        actions={androidHeaderActions}
        hideBottomBorder
      />
      {native.fallback}
    </>
  );
}
