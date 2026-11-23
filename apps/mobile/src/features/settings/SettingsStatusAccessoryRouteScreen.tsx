import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  usedPercentLabel,
  recentUseBySource,
} from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  STATUS_ACCESSORY_ITEMS,
  moveStatusAccessoryItem,
  resolveStatusAccessoryItems,
  type StatusAccessoryItem,
} from "../../lib/statusAccessoryItems";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import {
  combinableRingDrivers,
  isLimitRingShown,
  STATUS_RING_LIMIT,
  summarizeProviderLimits,
} from "../usage/limitsGlance";
import { STATUS_ACCESSORY_ITEM_INFO } from "../workspace/statusAccessory";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/**
 * What the capsule between the phone tab bar and the compose button shows,
 * and in which order. Shown items drag to reorder; the rest add with a tap.
 */
export function SettingsStatusAccessoryRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const shown = resolveStatusAccessoryItems(
    AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.statusAccessoryItems
      : undefined,
  );
  const available = STATUS_ACCESSORY_ITEMS.filter((item) => !shown.includes(item));
  const ringChoices = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.statusAccessoryRings
    : undefined;
  const combinedRings = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.statusAccessoryCombinedRings
    : undefined;
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // The list only needs who reports limits; one clock reading when the screen opens is enough.
  const [openedAt] = useState(() => Date.now());
  const rings = summarizeProviderLimits(
    collectLimitPools(
      collectLimitAccounts(presentations),
      openedAt,
      recentUseBySource(presentations),
    ),
  );
  const [drag, setDrag] = useState<{
    readonly item: StatusAccessoryItem;
    readonly translation: number;
  } | null>(null);
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored list, so concurrent edits are not lost.
  const update = (transform: (items: readonly StatusAccessoryItem[]) => StatusAccessoryItem[]) =>
    savePreferences({
      transform: (current) => ({
        statusAccessoryItems: transform(resolveStatusAccessoryItems(current.statusAccessoryItems)),
      }),
    });
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(shown.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) - from;
  const dragFrom = drag === null ? -1 : shown.indexOf(drag.item);
  const dragTo = drag === null ? -1 : dragFrom + dropSteps(dragFrom, drag.translation);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="In the bottom bar">
          {shown.length === 0 ? (
            <Text className="px-4 py-4 text-sm text-foreground-muted">
              Nothing is shown. Add an item below.
            </Text>
          ) : null}
          {shown.map((item, index) => {
            const shift =
              dragFrom === -1 || index === dragFrom
                ? 0
                : dragFrom < dragTo && index > dragFrom && index <= dragTo
                  ? -rowHeight
                  : dragFrom > dragTo && index < dragFrom && index >= dragTo
                    ? rowHeight
                    : 0;
            return (
              <AccessoryItemRow
                key={`${item}:${drops}`}
                item={item}
                position={index + 1}
                count={shown.length}
                disabled={!ready}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                action="remove"
                onAction={() => update((items) => items.filter((entry) => entry !== item))}
                reorder={{
                  onHeight: setRowHeight,
                  onStart: () => setDrag({ item, translation: 0 }),
                  onMove: (translation) => setDrag({ item, translation }),
                  onEnd: (translation, cancelled) => {
                    setDrag(null);
                    setDrops((value) => value + 1);
                    if (!cancelled) {
                      const steps = dropSteps(index, translation);
                      update((items) => moveStatusAccessoryItem(items, item, steps));
                    }
                  },
                  onStep: (direction) =>
                    update((items) =>
                      moveStatusAccessoryItem(items, item, direction === "up" ? -1 : 1),
                    ),
                }}
              />
            );
          })}
        </SettingsSection>
        {shown.includes("limits") && rings.length > 0 ? (
          <SettingsSection
            title="Limit rings"
            footer={`The row shows up to ${STATUS_RING_LIMIT}: the plans your chats and subagents used most lately, then the ones closest to running out. Usage lists them all.`}
          >
            {rings.map((entry) => (
              <SettingsSwitchRow
                key={entry.pool.key}
                label={entry.pool.label ?? PROVIDER_DISPLAY_NAMES[entry.driver] ?? entry.driver}
                subtitle={`${entry.tightest.label} ${usedPercentLabel(entry.tightest)}`}
                disabled={!ready}
                value={isLimitRingShown(entry, ringChoices)}
                onValueChange={(value) =>
                  savePreferences({
                    transform: (current) => ({
                      statusAccessoryRings: {
                        ...current.statusAccessoryRings,
                        [entry.pool.key]: value,
                      },
                    }),
                  })
                }
              />
            ))}
            {combinableRingDrivers(rings).map(({ driver, plans }) => {
              const name = PROVIDER_DISPLAY_NAMES[driver] ?? driver;
              return (
                <SettingsSwitchRow
                  key={`combine:${driver}`}
                  label={`Combine ${name} rings`}
                  subtitle={`One ring for the ${plans} ${name} plans switched on above, showing their average use`}
                  disabled={!ready}
                  value={combinedRings?.includes(driver) ?? false}
                  onValueChange={(value) =>
                    savePreferences({
                      transform: (current) => {
                        const others = (current.statusAccessoryCombinedRings ?? []).filter(
                          (entry) => entry !== driver,
                        );
                        return {
                          statusAccessoryCombinedRings: value ? [...others, driver] : others,
                        };
                      },
                    })
                  }
                />
              );
            })}
          </SettingsSection>
        ) : null}
        {available.length > 0 ? (
          <SettingsSection title="More items">
            {available.map((item, index) => (
              <AccessoryItemRow
                key={item}
                item={item}
                position={index + 1}
                count={available.length}
                disabled={!ready}
                offset={0}
                lifted={false}
                action="add"
                onAction={() =>
                  update((items) => (items.includes(item) ? [...items] : [...items, item]))
                }
              />
            ))}
          </SettingsSection>
        ) : null}
        <Text className="px-2 text-sm text-foreground-muted">
          Your status row sits above the tabs on iPhone. Tap it to open usage; long-press it to come
          back here. Swipe sideways to see more items when space is tight.
        </Text>
      </ScrollView>
    </View>
  );
}

function AccessoryItemRow(props: {
  readonly item: StatusAccessoryItem;
  readonly position: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly action: "add" | "remove";
  readonly onAction: () => void;
  /** Shown items drag to reorder; available ones do not. */
  readonly reorder?: {
    readonly onHeight: (height: number) => void;
    readonly onStart: () => void;
    readonly onMove: (translation: number) => void;
    readonly onEnd: (translation: number, cancelled: boolean) => void;
    readonly onStep: (direction: "up" | "down") => void;
  };
}) {
  const { lifted, offset } = props;
  const info = STATUS_ACCESSORY_ITEM_INFO[props.item];
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  const { reorder } = props;
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => reorder?.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        "flex-row items-center pl-1",
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
        !reorder && "pr-4",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.action === "add" ? "Show" : "Hide"} ${info.title}`}
        disabled={props.disabled}
        onPress={props.onAction}
        className="size-11 items-center justify-center active:opacity-70"
      >
        <SymbolView
          name={
            props.action === "add"
              ? { ios: "plus.circle.fill", android: "check" }
              : { ios: "minus.circle.fill", android: "remove" }
          }
          size={20}
          tintColorClassName={
            props.action === "add" ? "accent-primary-text" : "accent-danger-foreground"
          }
          type="monochrome"
        />
      </Pressable>
      <View
        accessible
        accessibilityLabel={`${info.title}. ${info.description}`}
        className="min-w-0 flex-1 flex-row items-center gap-3 py-3.5"
      >
        <SymbolView name={info.icon} size={18} tintColorClassName="accent-icon" type="monochrome" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base text-foreground">
            {info.title}
          </Text>
          <Text numberOfLines={2} className="text-sm text-foreground-muted">
            {info.description}
          </Text>
        </View>
      </View>
      {reorder ? (
        <SettingsDragHandle
          title={info.title}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={reorder.onStart}
          onMove={reorder.onMove}
          onEnd={reorder.onEnd}
          onStep={reorder.onStep}
        />
      ) : null}
    </Reanimated.View>
  );
}
