import { useEnvironmentDisplayLabel } from "../../state/environment-labels";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
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
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {host.message ?? "Looking for sessions…"}
        </Text>
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
      {loading ? (
        <Text className="py-2 text-sm text-foreground-muted">Looking for sessions…</Text>
      ) : null}
      {sessionsQuery.error ? (
        <View className="gap-2 py-2">
          <Text className="text-sm text-danger-foreground">
            {props.label}: {sessionsQuery.error}
          </Text>
          <MaterialButton tone="text" label="Try again" onPress={() => sessionsQuery.refresh()} />
        </View>
      ) : null}
      {!loading && sessionsQuery.error === null && sessions.length === 0 ? (
        <Text className="py-2 text-sm text-foreground-muted">
          {props.query.trim().length > 0
            ? "No sessions match that search."
            : "No Claude Code sessions with Remote Control are running."}
        </Text>
      ) : null}
    </ScrollView>
  );
}
