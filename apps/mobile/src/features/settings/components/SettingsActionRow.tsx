import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../../components/AppActivityIndicator";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { MaterialListRow } from "../../../components/MaterialListRow";
import { cn } from "../../../lib/cn";

export function SettingsActionRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  const danger = props.tone === "danger";
  const textClassName = danger ? "tabular-nums text-danger-foreground" : "text-foreground";
  const iconColorClassName = danger ? "accent-danger-foreground" : "accent-icon";
  const icon = (
    <SymbolView
      name={props.icon}
      size={Platform.OS === "android" ? 24 : 22}
      tintColorClassName={iconColorClassName}
      type="monochrome"
      weight="regular"
    />
  );
  const spinner = props.loading ? (
    <AppActivityIndicator colorClassName={iconColorClassName} />
  ) : null;

  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.label}
        titleClassName={textClassName}
        leading={icon}
        trailing={spinner}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }

  return (
    // Same geometry as ListRowLayout, so an action row's icon and label line
    // up with the navigation and switch rows in its card.
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 px-4 py-3 disabled:opacity-40"
    >
      <View className="size-6 items-center justify-center">{icon}</View>
      <Text className={cn("flex-1 text-base", textClassName)}>{props.label}</Text>
      {spinner}
    </Pressable>
  );
}
