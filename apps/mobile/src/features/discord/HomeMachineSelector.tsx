import { useEnvironmentDisplayLabels } from "../../state/environment-labels";
import { usePrivacyLabel } from "../../state/use-privacy-mode";
import { useWorkspaceEnvironments } from "../../state/workspace";
import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, View } from "react-native";
import {
  resolveEnvironmentMachineKind,
  type ServerConfig,
  type EnvironmentId,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { discordSurfaces } from "./discordTheme";

export function HomeMachines(props: {
  readonly unknownCountEnvironments?: ReadonlySet<string>;
  readonly rail: boolean;
  readonly machines: ReadonlyMap<string, { needsYou: number; unread: boolean }>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly top: number;
  readonly bottom: number;
}) {
  const environmentLabels = useEnvironmentDisplayLabels();
  const privateLabel = usePrivacyLabel();
  const environments = useWorkspaceEnvironments();
  const { themeAppearance } = useAppearancePreferences();
  const colors = discordSurfaces(themeAppearance);
  const entries = [
    null,
    ...(props.rail
      ? new Set([
          ...props.machines.keys(),
          ...environments.map((environment) => environment.environmentId),
        ])
      : props.machines.keys()),
  ];
  return (
    <ScrollView
      horizontal={!props.rail}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      style={
        props.rail ? { width: 72, flexGrow: 0, backgroundColor: colors.rail } : { flexGrow: 0 }
      }
      contentContainerStyle={
        props.rail
          ? {
              paddingTop: props.top + 12,
              paddingBottom: props.bottom,
              gap: 8,
              alignItems: "center",
            }
          : { paddingHorizontal: 14, paddingBottom: 12, gap: 8 }
      }
    >
      {entries.map((id) => {
        const config = id === null ? undefined : props.configs.get(id as EnvironmentId);
        const label =
          id === null
            ? "All chats"
            : privateLabel(
                "Computer",
                id,
                environmentLabels.get(id) ?? config?.environment.label ?? "Machine",
              );
        const summary =
          id === null
            ? {
                needsYou: [...props.machines.values()].reduce(
                  (sum, machine) => sum + machine.needsYou,
                  0,
                ),
                unread: [...props.machines.values()].some((machine) => machine.unread),
              }
            : (props.machines.get(id) ?? { needsYou: 0, unread: false });
        const countsKnown =
          id === null
            ? !props.unknownCountEnvironments?.size
            : !props.unknownCountEnvironments?.has(id);
        const selected = props.selected === id;
        return (
          <View key={id ?? "all"}>
            <Pressable
              hitSlop={props.rail ? 0 : 4}
              accessibilityRole="button"
              accessibilityLabel={`${label}${countsKnown && summary.needsYou ? `, ${summary.needsYou} chats need you` : ""}${countsKnown && summary.unread ? ", unread" : ""}`}
              accessibilityState={{ selected }}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                props.onSelect(id);
              }}
              className={
                props.rail
                  ? "size-[48px] items-center justify-center"
                  : `min-h-[36px] flex-row items-center gap-2 rounded-full border border-border px-3${selected ? " bg-subtle-strong" : ""}`
              }
              style={
                props.rail
                  ? {
                      borderRadius: selected ? 16 : 24,
                      backgroundColor: selected
                        ? "#5865F2"
                        : themeAppearance === "dark"
                          ? "#313338"
                          : "#FFFFFF",
                    }
                  : undefined
              }
            >
              {id === null ? (
                <SymbolView
                  name="bubble.left.and.bubble.right"
                  size={props.rail ? 24 : 16}
                  tintColorClassName={props.rail && selected ? "accent-white" : "accent-foreground"}
                />
              ) : (
                <EnvironmentMachineSymbol
                  kind={config ? resolveEnvironmentMachineKind(config) : "server"}
                  size={props.rail ? 24 : 16}
                  tintColorClassName={props.rail && selected ? "accent-white" : "accent-foreground"}
                />
              )}
              {props.rail && id !== null && summary.needsYou === 0 ? (
                <View
                  accessibilityLabel={
                    environments.find((environment) => environment.environmentId === id)
                      ?.connectionState === "connected"
                      ? "Online"
                      : "Offline"
                  }
                  style={{
                    position: "absolute",
                    right: -1,
                    bottom: -1,
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    borderWidth: 3,
                    borderColor: colors.rail,
                    backgroundColor:
                      environments.find((environment) => environment.environmentId === id)
                        ?.connectionState === "connected"
                        ? "#23A55A"
                        : "#949BA4",
                  }}
                />
              ) : null}
              {!props.rail ? (
                <Text className="text-sm font-t3-medium">{id === null ? "All" : label}</Text>
              ) : null}
              {countsKnown && summary.needsYou > 0 ? (
                <View
                  style={
                    props.rail
                      ? {
                          position: "absolute",
                          right: -6,
                          bottom: -5,
                          borderWidth: 3,
                          borderColor: colors.rail,
                        }
                      : undefined
                  }
                  className="min-w-5 items-center rounded-full bg-danger-foreground px-1"
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "700" }}>
                    {summary.needsYou}
                  </Text>
                </View>
              ) : null}
              {props.rail && (selected || (countsKnown && summary.unread)) ? (
                <View
                  style={{
                    position: "absolute",
                    left: -12,
                    width: 8,
                    height: selected ? 40 : 8,
                    borderRadius: 4,
                    backgroundColor: colors.primary,
                  }}
                />
              ) : null}
            </Pressable>
            {props.rail && id === null ? (
              <View
                style={{
                  width: 32,
                  height: 2,
                  marginTop: 12,
                  alignSelf: "center",
                  backgroundColor: themeAppearance === "dark" ? "#3F4147" : "#D4D6DB",
                }}
              />
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
