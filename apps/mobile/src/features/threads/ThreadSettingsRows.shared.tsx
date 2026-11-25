import { formatOutOfCredit } from "@t3tools/client-runtime/providerHealth";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import type { ModelOption } from "../../lib/modelOptions";

export type ModelRowProps = {
  readonly option: ModelOption;
  /** Drawn before the label: the maker's mark on a Favorites row, where makers mix. */
  readonly icon?: ReactNode;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isFavorite: boolean;
  readonly favoritesLoaded: boolean;
  readonly onToggleFavorite: () => void;
  readonly onToggleHidden?: () => void;
  readonly hiddenUpdatePending?: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
};

export type ChoiceRowProps = {
  readonly label: string;
  /** Drawn before the label: the harness a Runs in row runs on. */
  readonly icon?: ReactNode;
  readonly description?: string;
  readonly trailingText?: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isLast: boolean;
};

type RowSelectionProps = {
  readonly leadingSelection?: ReactNode;
  readonly trailingSelection?: ReactNode;
  readonly minimumHeight?: number;
};

export function ModelRowContent(
  props: ModelRowProps &
    RowSelectionProps & {
      readonly labelNumberOfLines: number;
      readonly selectedClassName?: string;
    },
) {
  const creditFailure = props.option.providerRecentFailure?.outOfCredit
    ? props.option.providerRecentFailure
    : null;
  return (
    <View
      style={props.minimumHeight === undefined ? undefined : { minHeight: props.minimumHeight }}
      className={cn(
        "mx-4 min-h-[44px] flex-row items-center gap-2 bg-grouped-card px-4",
        props.selectedClassName,
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
    >
      <Pressable
        accessibilityLabel={[props.option.label, props.option.subtitle].filter(Boolean).join(", ")}
        accessibilityRole="radio"
        accessibilityState={{
          checked: props.selected,
          disabled: props.option.isUnavailable === true || props.option.isHidden === true,
        }}
        className="min-h-[44px] min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
        disabled={props.option.isUnavailable || props.option.isHidden}
        onPress={props.onPress}
      >
        {props.leadingSelection}
        {props.icon}
        <View className="min-w-0 flex-1">
          <Text
            className="text-base font-t3-medium text-foreground"
            numberOfLines={props.labelNumberOfLines}
          >
            {props.option.label}
          </Text>
          {props.option.subtitle ? (
            <Text
              className="text-xs text-foreground-muted"
              numberOfLines={props.labelNumberOfLines}
            >
              {props.option.subtitle}
            </Text>
          ) : null}
          {creditFailure ? (
            <Text className="mt-1 text-xs text-warning-foreground" numberOfLines={3}>
              <Text className="font-t3-bold">Out of credit</Text>
              {"\n"}
              {formatOutOfCredit(creditFailure)}
            </Text>
          ) : null}
          {props.option.isDefault ||
          props.option.isLegacy ||
          props.option.isHidden ||
          props.option.isUnavailable ? (
            <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
              {props.option.isDefault ? (
                <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
                  <Text className="text-3xs font-t3-bold text-foreground-muted">Default</Text>
                </View>
              ) : null}
              {props.option.isLegacy ? (
                <View className="rounded-md bg-subtle px-1.5 py-0.5">
                  <Text className="text-3xs font-t3-bold text-foreground-muted">Legacy</Text>
                </View>
              ) : null}
              {props.option.isHidden ? (
                <Text className="text-xs text-foreground-muted">Hidden</Text>
              ) : null}
              {props.option.isUnavailable ? (
                <Text className="text-xs text-foreground">Unavailable</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {props.trailingSelection}
      </Pressable>
      {props.onToggleHidden ? (
        <Pressable
          accessibilityLabel={`${props.option.isHidden ? "Show" : "Hide"} model: ${props.option.providerLabel}, ${props.option.label}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.hiddenUpdatePending === true }}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
          disabled={props.hiddenUpdatePending}
          onPress={props.onToggleHidden}
        >
          <SymbolView
            name={props.option.isHidden ? "eye.slash" : "eye"}
            size={18}
            tintColorClassName={props.option.isHidden ? "accent-icon-subtle" : "accent-icon"}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={`${props.isFavorite ? "Remove from" : "Add to"} favorites: ${
          props.option.providerLabel
        }, ${props.option.label}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: !props.favoritesLoaded, selected: props.isFavorite }}
        className="min-h-[44px] min-w-[44px] items-center justify-center"
        disabled={!props.favoritesLoaded}
        onPress={props.onToggleFavorite}
      >
        <SymbolView
          name={props.isFavorite ? "star.fill" : "star"}
          size={18}
          tintColorClassName={props.isFavorite ? "accent-icon" : "accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

/** Single option inside a submenu panel. */
export function ChoiceRowContent(props: ChoiceRowProps & RowSelectionProps) {
  return (
    <Pressable
      accessibilityLabel={[props.label, props.trailingText, props.description]
        .filter(Boolean)
        .join(". ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      style={props.minimumHeight === undefined ? undefined : { minHeight: props.minimumHeight }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      {props.leadingSelection}
      {props.icon}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-5 text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      {props.trailingText ? (
        <Text className="text-sm text-foreground-muted">{props.trailingText}</Text>
      ) : null}
      {props.trailingSelection}
    </Pressable>
  );
}
