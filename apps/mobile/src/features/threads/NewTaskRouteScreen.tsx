import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialListRow } from "../../components/MaterialListRow";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  isNewTaskDraftKey,
} from "../../state/use-composer-drafts";
import { usePrivacyLabel } from "../../state/use-privacy-mode";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { usePromptLinkResolver } from "../prompt-links/usePromptLinkResolver";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  buildMachinePickerItems,
  opensScratchDraft,
  resolveIncomingShareRouteAction,
  resolveMachineScratchSelection,
  resolveScratchStart,
  type MachinePickerItem,
} from "./new-task-project-selection";

type NewTaskRouteParams = {
  /**
   * Show the machine picker instead of auto-opening a project-less draft on the
   * usual machine. Without it, a bare New Task opens a chat without a project
   * directly (see `opensScratchDraft`).
   */
  readonly pickMachine?: string | string[];
  /** Legacy alias kept so older callers/links still open the machine picker. */
  readonly pickProject?: string | string[];
  /** Existing new-task draft to retarget when a machine is chosen. */
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
  // An `sshcode://new?…` prompt link. See usePromptLinkResolver.
  readonly prompt?: string | string[];
  readonly repo?: string | string[];
  readonly pr?: string | string[];
  readonly provider?: string | string[];
  readonly model?: string | string[];
};

function deriveMachineEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading machines",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No machines connected",
      detail: "Add an environment to start a chat.",
      loading: false,
    };
  }

  return {
    title: "No machines enabled",
    detail: "Turn on a saved environment in Settings or add a new one to start a chat.",
    loading: false,
  };
}

function NewTaskHeader(props: { readonly title: string; readonly subtitle: string | null }) {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  return (
    <ScreenHeader
      title={props.title}
      subtitle={props.subtitle ?? undefined}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      options={{ headerBackVisible: !layout.usesSplitView }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={[]}
    />
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const privateLabel = usePrivacyLabel();
  const projects = useProjects();
  const { selectedEnvironmentId, usualEnvironmentId, setProject, openDraftOnProject } =
    useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  usePromptLinkResolver(route.params);
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const routeDraftId = Array.isArray(route.params?.draftId)
    ? route.params.draftId[0]
    : route.params?.draftId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a machine for what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose a machine for the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose a machine for the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const emptyState = deriveMachineEmptyState(catalogState);
  const serverConfigs = useServerConfigs();
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: false,
  });
  const machineEnvironments = connectedEnvironments;
  const machineItems = useMemo(
    () =>
      buildMachinePickerItems({
        environments: connectedEnvironments,
        selectedEnvironmentId,
      }),
    [connectedEnvironments, selectedEnvironmentId],
  );
  // A chat without a project starts on the usual machine, even while it
  // reconnects, when this device knows its project there; the draft page's
  // machine picker moves it from there.
  const scratchStart = useMemo(
    () =>
      resolveScratchStart({
        environments: machineEnvironments,
        usualEnvironmentId,
        selectedEnvironmentId,
        offersScratch: (environmentId) => {
          const environment = machineEnvironments.find(
            (candidate) => candidate.environmentId === environmentId,
          );
          return (
            environment !== undefined &&
            availableScratchWorkspaceRoot(
              environment.connectionState,
              serverConfigs.get(environmentId),
            ) !== null
          );
        },
        projects,
        isScratchProject: (project) =>
          isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      }),
    [machineEnvironments, projects, selectedEnvironmentId, serverConfigs, usualEnvironmentId],
  );
  const scratchStartInFlightRef = useRef(false);
  const [openingEnvironmentId, setOpeningEnvironmentId] = useState<EnvironmentId | null>(null);
  // Decided once per route: a later param or focus change must not reopen it.
  const [directScratch, setDirectScratch] = useState<"pending" | "off">(() =>
    opensScratchDraft(route.params, navigation.getState()?.index) ? "pending" : "off",
  );
  // A machine on its first connection attempt may offer a thread without a
  // project in a moment, even when its threads are already cached on this
  // device. A reconnect in backoff can retry forever, so it is not waited on.
  const environmentsSettling =
    catalogState.isLoadingConnections ||
    catalogState.connectingEnvironments.some(
      (environment) => environment.connectionState === "connecting",
    );
  const shareRouteAction = resolveIncomingShareRouteAction({
    hasReservedDestination: Boolean(incomingShare?.destination),
    reservedDestinationProject,
    projectsCount: projects.length,
    environmentsSettling,
    hasPendingShellSnapshot: catalogState.hasPendingShellSnapshot,
  });

  const bindAndOpenDraft = useCallback(
    (project: EnvironmentProject, options?: { readonly instant?: boolean }) => {
      const state = navigation.getState();
      const previousRoute = state?.routes[state.index - 1];
      if (previousRoute?.name === "NewTaskDraft") {
        setProject(project);
        navigation.goBack();
        return;
      }

      const draftId =
        routeDraftId &&
        isNewTaskDraftKey(routeDraftId) &&
        !isComposerDraftEmpty(getComposerDraftSnapshot(routeDraftId))
          ? routeDraftId
          : null;
      if (draftId) {
        openDraftOnProject(draftId, project);
      } else {
        setProject(project);
      }
      navigation.dispatch(
        StackActions.replace("NewTaskDraft", {
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          ...(options?.instant ? { instant: "1" } : {}),
          ...(draftId ? { draftId } : {}),
          ...(incomingShare
            ? { incomingShareId: incomingShare.id }
            : routeShareId
              ? { incomingShareId: routeShareId }
              : {}),
        }),
      );
    },
    [incomingShare, navigation, openDraftOnProject, routeDraftId, routeShareId, setProject],
  );

  async function selectScratchProject(project: EnvironmentProject): Promise<void> {
    if (
      incomingShare?.destination &&
      (incomingShare.destination.environmentId !== project.environmentId ||
        incomingShare.destination.projectId !== project.id)
    ) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Alert.alert(
          "Could not change machine",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    bindAndOpenDraft(project);
  }

  async function selectMachine(machine: MachinePickerItem): Promise<void> {
    if (
      openingEnvironmentId !== null ||
      scratchStartInFlightRef.current ||
      reservedDestinationProject !== null
    ) {
      return;
    }
    const label = privateLabel("Computer", machine.environmentId, machine.environmentLabel);
    const offersScratch =
      availableScratchWorkspaceRoot(
        machine.connectionState,
        serverConfigs.get(machine.environmentId),
      ) !== null;
    const selection = resolveMachineScratchSelection({
      environmentId: machine.environmentId,
      connectionState: machine.connectionState,
      offersScratch,
      projects,
      isScratchProject: (project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
    });

    if (selection.kind === "unavailable") {
      Alert.alert(
        selection.reason === "offline" ? `${label} is offline` : "Could not start a chat",
        selection.reason === "offline"
          ? `Connect to ${label} to start a chat on it.`
          : `${label} does not support chats without a project.`,
      );
      return;
    }

    if (selection.kind === "open") {
      if (selection.refresh) {
        void openScratch({ environmentId: selection.project.environmentId, input: {} });
      }
      await selectScratchProject(selection.project);
      return;
    }

    scratchStartInFlightRef.current = true;
    setOpeningEnvironmentId(machine.environmentId);
    try {
      const result = await openScratch({ environmentId: selection.environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start a chat",
            error instanceof Error
              ? error.message
              : "The folder for new chats could not be created.",
          );
        }
        return;
      }
      await selectScratchProject(result.value);
    } finally {
      scratchStartInFlightRef.current = false;
      setOpeningEnvironmentId(null);
    }
  }

  useEffect(() => {
    if (directScratch !== "pending" || !isFocused) return;
    if (shareRouteAction.kind === "resume_reserved" || shareRouteAction.kind === "wait") {
      return;
    }
    if (scratchStartInFlightRef.current) return;
    if (scratchStart.kind === "none") {
      // Machines still connecting may offer it in a moment; otherwise the
      // machine list is the way in.
      if (!environmentsSettling) setDirectScratch("off");
      return;
    }

    const completeDirectScratch = async (project: EnvironmentProject) => {
      if (
        shareRouteAction.kind === "release_and_fallback" &&
        incomingShare?.destination &&
        (incomingShare.destination.environmentId !== project.environmentId ||
          incomingShare.destination.projectId !== project.id)
      ) {
        try {
          await releaseShareReservation(incomingShare.id, incomingShare.destination);
        } catch {
          scratchStartInFlightRef.current = false;
          setDirectScratch("off");
          return;
        }
      }
      if (!navigation.isFocused()) return;
      bindAndOpenDraft(project, { instant: true });
    };

    scratchStartInFlightRef.current = true;
    if (scratchStart.kind === "open") {
      // Known already: open at once (offline, the draft queues until the
      // machine is back), and let a connected machine re-create the folder if
      // it went missing. The route is replaced, so the latch stays set.
      if (scratchStart.refresh) {
        void openScratch({ environmentId: scratchStart.project.environmentId, input: {} });
      }
      if (shareRouteAction.kind === "release_and_fallback") {
        void completeDirectScratch(scratchStart.project);
      } else {
        bindAndOpenDraft(scratchStart.project, { instant: true });
      }
      return;
    }
    void openScratch({ environmentId: scratchStart.environmentId, input: {} }).then((result) => {
      // The sheet may have been dismissed while the folder was made.
      if (!navigation.isFocused()) return;
      if (result._tag === "Success") {
        void completeDirectScratch(result.value);
        return;
      }
      scratchStartInFlightRef.current = false;
      setDirectScratch("off");
    });
  }, [
    bindAndOpenDraft,
    directScratch,
    environmentsSettling,
    incomingShare,
    isFocused,
    navigation,
    openScratch,
    releaseShareReservation,
    scratchStart,
    shareRouteAction.kind,
  ]);

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Returning from the reserved draft is a fresh resume attempt. Keeping
      // this latch set would leave every machine row disabled with no route.
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (shareRouteAction.kind !== "resume_reserved") {
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    const project = shareRouteAction.project;
    setProject(project);
    navigation.dispatch(
      StackActions.replace("NewTaskDraft", {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        instant: "1",
        incomingShareId: incomingShare.id,
      }),
    );
  }, [incomingShare, isFocused, navigation, setProject, shareRouteAction]);

  if (directScratch === "pending") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <NewTaskHeader title="New chat" subtitle={null} />
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader title="Choose machine" subtitle={incomingShareSubtitle} />

      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && machineItems.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {machineItems.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {emptyState.loading ? (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {emptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {emptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <MaterialButton
                  label="Add environment"
                  tone="primary"
                  onPress={() => navigation.navigate("ConnectionsNew")}
                />
              ) : (
                <Pressable
                  className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                  onPress={() => navigation.navigate("ConnectionsNew")}
                >
                  <Text className="text-sm font-t3-bold text-primary-foreground">
                    Add environment
                  </Text>
                </Pressable>
              )}
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {machineItems.map((machine, machineIndex) => {
                const label = privateLabel(
                  "Computer",
                  machine.environmentId,
                  machine.environmentLabel,
                );
                const isOpening = openingEnvironmentId === machine.environmentId;
                const disabled =
                  reservedDestinationProject !== null || openingEnvironmentId !== null;
                const machineKind = resolveEnvironmentMachineKind(
                  serverConfigs.get(machine.environmentId) ?? null,
                );
                if (Platform.OS === "android") {
                  return (
                    <MaterialListRow
                      className="bg-grouped-card"
                      key={String(machine.environmentId)}
                      title={label}
                      subtitle={machine.statusHint}
                      subtitleNumberOfLines={1}
                      disabled={disabled}
                      onPress={() => void selectMachine(machine)}
                      leading={
                        <EnvironmentMachineSymbol
                          kind={machineKind}
                          size={24}
                          tintColorClassName="accent-icon-muted"
                        />
                      }
                      trailing={
                        isOpening ? (
                          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
                        ) : undefined
                      }
                    />
                  );
                }
                return (
                  <View
                    key={String(machine.environmentId)}
                    className={cn(machineIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${label}, ${machine.statusHint}`}
                      disabled={disabled}
                      onPress={() => void selectMachine(machine)}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <EnvironmentMachineSymbol
                          kind={machineKind}
                          size={20}
                          tintColorClassName="accent-icon-muted"
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className="text-base font-t3-bold leading-snug" numberOfLines={1}>
                          {label}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          numberOfLines={1}
                        >
                          {machine.statusHint}
                        </Text>
                      </View>
                      {isOpening ? (
                        <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
                      ) : (
                        <SymbolView
                          name="chevron.right"
                          size={14}
                          tintColorClassName="accent-chevron"
                          type="monochrome"
                        />
                      )}
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
