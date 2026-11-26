import { useEnvironmentDisplayLabel } from "../../state/environment-labels";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import { useMemo, type ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { environmentCatalog } from "../../connection/catalog";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { claudeRcEnvironment } from "../../state/claudeRc";
import {
  TERMINAL_SESSION_LABEL,
  filterTerminalSessions,
  terminalHostPhase,
  terminalListEnvironmentId,
  terminalSessionRelativeTime,
} from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionsPanel(props: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }[];
  readonly selectedMachineId: string | null;
  readonly searchQuery: string;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = useMemo(() => {
    for (const [environmentId, entry] of catalog.entries) {
      if (entry.target._tag === "PrimaryConnectionTarget") return environmentId;
    }
    return null;
  }, [catalog]);
  const environmentId = terminalListEnvironmentId(
    props.selectedMachineId,
    primaryEnvironmentId,
    props.environments.map((environment) => environment.environmentId),
  );
  const environment = props.environments.find((item) => item.environmentId === environmentId);
  const config = environmentId === null ? undefined : serverConfigs.get(environmentId);
  const phase = environment?.connectionState;
  const host = terminalHostPhase({
    environmentId,
    connected: phase === "connected",
    connecting: phase === "connecting" || phase === "reconnecting",
    configLoaded: config !== undefined,
    claudeRemoteControl: config?.environment.capabilities.claudeRemoteControl,
  });
  const navigation = useNavigation();
  const environmentLabel = useEnvironmentDisplayLabel(environmentId);
  const label = environmentLabel ?? config?.environment.label ?? "Machine";

  return (
    <View className="min-h-0 flex-1">
      {host.phase === "ready" && environmentId !== null ? (
        <ReadyTerminalSessions
          environmentId={environmentId}
          label={label}
          query={props.searchQuery}
          onOpen={(session) =>
            navigation.navigate("TerminalSession", {
              environmentId: String(environmentId),
              sessionId: session.id,
            })
          }
        />
      ) : (
        <TerminalSessionsNotice>
          {host.message ? (
            <EmptyState title="Terminal sessions" detail={host.message} variant="plain" />
          ) : (
            <LookingForSessions />
          )}
        </TerminalSessionsNotice>
      )}
    </View>
  );
}

function ReadyTerminalSessions(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly query: string;
  readonly onOpen: (session: ClaudeRcSession) => void;
}) {
  const sessionsQuery = useEnvironmentQuery(
    claudeRcEnvironment.sessions({ environmentId: props.environmentId, input: {} }),
  );
  const sessions = filterTerminalSessions(sessionsQuery.data ?? [], props.query);
  const loading = sessionsQuery.data === null && sessionsQuery.error === null;
  // With nothing to list, say so the way Home's other empty lists do: one calm block in the
  // middle of the screen, not a line of text under the tabs.
  if (sessions.length === 0) {
    return (
      <TerminalSessionsNotice>
        {loading ? (
          <LookingForSessions />
        ) : sessionsQuery.error ? (
          <EmptyState
            title="Can't reach terminal sessions"
            detail={`${props.label}: ${sessionsQuery.error}`}
            actionLabel="Try again"
            onAction={() => sessionsQuery.refresh()}
            variant="plain"
          />
        ) : props.query.trim().length > 0 ? (
          <EmptyState title="No results" detail="No sessions match that search." variant="plain" />
        ) : (
          <EmptyState
            title="No terminal sessions"
            detail={`Claude Code sessions running with Remote Control on ${props.label} show up here.`}
            variant="plain"
          />
        )}
      </TerminalSessionsNotice>
    );
  }
  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-1 px-4 py-2">
      {sessions.map((session) => (
        <Pressable
          key={session.id}
          accessibilityRole="button"
          accessibilityLabel={`${session.title || TERMINAL_SESSION_LABEL}, ${TERMINAL_SESSION_LABEL}`}
          className="min-h-14 justify-center rounded-2xl px-1 py-2 active:opacity-70"
          onPress={() => props.onOpen(session)}
        >
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {session.title || TERMINAL_SESSION_LABEL}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {terminalSessionRelativeTime(session.updatedAt)}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {TERMINAL_SESSION_LABEL} · {props.label}
          </Text>
          {session.working ? <Text className="text-xs text-primary-text">Working</Text> : null}
        </Pressable>
      ))}
      {sessionsQuery.error ? (
        <Text className="py-2 text-sm text-foreground-muted">
          {props.label}: {sessionsQuery.error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/** Centers a notice in the space under the tabs, above the bottom bar. */
function TerminalSessionsNotice(props: { readonly children: ReactNode }) {
  return (
    <View className="w-full max-w-[430px] flex-1 items-center justify-center self-center px-8 pb-36">
      {props.children}
    </View>
  );
}

function LookingForSessions() {
  return (
    <View className="items-center gap-3">
      <AppActivityIndicator colorClassName="accent-icon-muted" />
      <Text className="text-sm text-foreground-muted">Looking for sessions…</Text>
    </View>
  );
}
