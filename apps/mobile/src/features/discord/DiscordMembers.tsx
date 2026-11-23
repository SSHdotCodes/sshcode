import type { ReactNode } from "react";
import { View } from "react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/AppSymbol";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { connectionWorkLabel, connectionWorkStatus } from "@t3tools/client-runtime/connection";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import {
  resolveThreadListV2DisplayStatus,
  resolveThreadListV2Status,
} from "../threads/threadListV2";

export function DiscordMember(props: {
  readonly name: string;
  readonly driver?: string | null;
  readonly status: string;
  readonly color: string;
  readonly user?: boolean;
  readonly icon?: "terminal" | "clock";
  readonly children?: ReactNode;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 py-1.5">
      <View className="relative size-[32px] items-center justify-center rounded-full bg-subtle-strong">
        {props.icon ? (
          <SymbolView name={props.icon} size={23} tintColorClassName="accent-foreground-muted" />
        ) : props.user ? (
          <SymbolView name="person.crop.circle" size={25} tintColorClassName="accent-foreground" />
        ) : (
          <ProviderIcon provider={props.driver} size={23} />
        )}
        <View
          className="border-sheet-solid"
          style={{
            position: "absolute",
            bottom: -1,
            right: -1,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 2,
            backgroundColor: props.color,
          }}
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "500" }}>
          {props.name}
        </Text>
        <Text numberOfLines={1} className="text-foreground-muted" style={{ fontSize: 12 }}>
          {props.status}
        </Text>
      </View>
      {props.children}
    </View>
  );
}

export function DiscordMainMembers(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const config = useEnvironmentServerConfig(props.environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === thread?.modelSelection.instanceId,
  );
  const connection = useRemoteEnvironmentRuntime(props.environmentId);
  const status = thread
    ? resolveThreadListV2DisplayStatus(
        resolveThreadListV2Status(thread),
        connection?.connectionState,
      )
    : "ready";
  const backgroundConnection = connectionWorkStatus(connection?.connectionState);
  const working = status === "working";
  const needsYou = status === "approval" || status === "input";
  const step = thread?.source.currentStep;
  const activity = step?.itemType === "reasoning" ? null : step?.detail;
  const background =
    thread?.pendingBackgroundTasks.filter((task) => task.kind !== "subagent") ?? [];
  return (
    <>
      <Text
        className="pt-5 pb-2 uppercase text-foreground-muted"
        style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.24 }}
      >
        Participants
      </Text>
      <DiscordMember name="You" status="Online" user color="#23A55A" />
      <DiscordMember
        name={provider?.displayName ?? provider?.driver ?? "Agent"}
        driver={provider?.driver}
        status={`${needsYou ? "Needs you" : working ? (activity ?? "Working") : status === "waiting" ? "Idle" : status === "connecting" || status === "reconnecting" || status === "offline" ? connectionWorkLabel(status) : "Offline"} · ${thread?.modelSelection.model ?? "Agent"}`}
        color={
          needsYou ? "#F23F43" : working ? "#23A55A" : status === "waiting" ? "#F0B232" : "#949BA4"
        }
      />
      {background.length > 0 ? (
        <>
          <Text
            className="pt-5 pb-2 uppercase text-foreground-muted"
            style={{ fontSize: 12, fontWeight: "600" }}
          >
            Background · {background.length}
          </Text>
          {background.map((task) => (
            <DiscordMember
              key={task.taskId}
              name={
                task.description ??
                (task.kind === "command"
                  ? "Background command"
                  : task.kind === "monitor"
                    ? "Monitor"
                    : "Background task")
              }
              icon={task.kind === "command" ? "terminal" : "clock"}
              status={
                backgroundConnection
                  ? connectionWorkLabel(backgroundConnection)
                  : task.kind === "command"
                    ? "Running"
                    : task.kind === "monitor"
                      ? "Monitoring"
                      : "Working"
              }
              color={
                connection && connection.connectionState !== "connected" ? "#949BA4" : "#23A55A"
              }
            />
          ))}
        </>
      ) : null}
    </>
  );
}
