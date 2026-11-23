import { useEnvironmentDisplayLabel } from "../../state/environment-labels";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import { claudeRcEnvironment } from "../../state/claudeRc";
import { useEnvironmentPresentation } from "../../state/presentation";
import { TerminalSessionChat } from "./TerminalSessionChat";
import {
  TERMINAL_SESSION_LABEL,
  TERMINAL_HOST_UPDATE_MESSAGE,
} from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionRouteScreen({
  route,
}: StaticScreenProps<{
  environmentId: string;
  sessionId: string;
}>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const environmentLabel = useEnvironmentDisplayLabel(environmentId);
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const navigation = useNavigation();
  if (config?.environment.capabilities.claudeRemoteControl !== true)
    return (
      <View className="flex-1 bg-screen p-4">
        <Text className="text-sm text-foreground-muted">
          {config ? TERMINAL_HOST_UPDATE_MESSAGE : "Connecting…"}
        </Text>
      </View>
    );
  return (
    <ReadyTerminalSession
      environmentId={environmentId}
      sessionId={route.params.sessionId}
      label={environmentLabel ?? config.environment.label}
      onBack={() => navigation.goBack()}
    />
  );
}

function ReadyTerminalSession(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly label: string;
  readonly onBack: () => void;
}) {
  const navigation = useNavigation();
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const phase = presentation?.connection.phase;
  const sessions = useEnvironmentQuery(
    claudeRcEnvironment.sessions({ environmentId: props.environmentId, input: {} }),
  );
  const session = sessions.data?.find((item) => item.id === props.sessionId) ?? {
    id: props.sessionId,
    title: TERMINAL_SESSION_LABEL,
    updatedAt: "",
    working: false,
  };
  useLayoutEffect(() => {
    navigation.setOptions({
      title: session.title || TERMINAL_SESSION_LABEL,
      headerSubtitle: `${TERMINAL_SESSION_LABEL} · ${props.label}`,
    });
  }, [navigation, session.title, props.label]);
  return (
    <TerminalSessionChat
      key={`${props.environmentId}:${props.sessionId}`}
      environmentId={props.environmentId}
      session={session}
      hostReady={phase === "connected"}
      hostMessage={
        phase === "connected"
          ? null
          : phase === "connecting" || phase === "reconnecting"
            ? "Reconnecting…"
            : "Disconnected from this machine."
      }
      onClose={props.onBack}
    />
  );
}
