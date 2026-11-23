import { MenuView } from "@react-native-menu/menu";
import type { ReactElement } from "react";
import { Platform, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import type { MediaActionFeedback, useMediaActions } from "../state/mediaActions";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";
import { ControlPillMenu } from "./ControlPill";

export function MediaActionsMenu(props: {
  readonly media: Pick<ReturnType<typeof useMediaActions>, "actions" | "title">;
  readonly inModal?: boolean;
  readonly children?: ReactElement<PressableProps>;
  readonly style?: StyleProp<ViewStyle>;
}) {
  if (props.media.actions.length === 0) return props.children ?? null;
  // Android's normal anchored menu lives in the app-root portal, behind native modals.
  const nativeAndroidMenu = props.inModal && Platform.OS === "android";
  const Menu = nativeAndroidMenu ? MenuView : ControlPillMenu;
  return (
    <Menu
      title={props.media.title}
      style={props.style}
      shouldOpenOnLongPress={props.children !== undefined}
      actions={props.media.actions.map(({ id, title, icon, disabled }) => ({
        id,
        title,
        // Android menus resolve images as drawables, which these SF Symbols are not.
        ...(Platform.OS === "ios" ? { image: icon } : {}),
        attributes: { disabled: disabled ?? false },
      }))}
      onPressAction={({ nativeEvent }) => {
        props.media.actions.find(({ id }) => id === nativeEvent.event)?.run();
      }}
    >
      {props.children ?? (
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel="Media actions"
          className="min-h-11 min-w-11 items-center justify-center rounded-md bg-black/60"
        >
          <SymbolView name="ellipsis" size={20} tintColor="#ffffff" type="monochrome" />
        </View>
      )}
    </Menu>
  );
}

const FEEDBACK_LABELS: Record<MediaActionFeedback, string> = {
  saved: "Saved to Photos",
  copied: "Copied",
};

/** A brief confirmation pill over the image a menu action just saved or copied. */
export function MediaActionFeedbackBadge(props: { readonly feedback: MediaActionFeedback | null }) {
  if (props.feedback === null) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(180)}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      className="absolute inset-0 items-center justify-center"
    >
      <View className="flex-row items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5">
        <SymbolView name="checkmark" size={12} tintColor="#ffffff" type="monochrome" />
        <AppText className="font-t3-medium text-xs text-white">
          {FEEDBACK_LABELS[props.feedback]}
        </AppText>
      </View>
    </Animated.View>
  );
}

/**
 * Progress while a video downloads for Save to Photos, then the saved confirmation.
 * Sits at the top so it never covers the play button or the player's controls.
 */
export function MediaActionStatusPill(props: {
  readonly media: Pick<ReturnType<typeof useMediaActions>, "busy" | "progress" | "feedback">;
}) {
  const saving = props.media.busy === "save-to-photos";
  if (!saving && props.media.feedback === null) return null;
  const label = saving
    ? props.media.progress === null
      ? "Saving…"
      : `Saving… ${props.media.progress}%`
    : FEEDBACK_LABELS[props.media.feedback!];
  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(180)}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      className="absolute inset-x-0 top-2 items-center"
    >
      <View className="min-w-28 overflow-hidden rounded-full bg-black/70">
        <View className="flex-row items-center justify-center gap-1.5 px-3 py-1.5">
          {saving ? null : (
            <SymbolView name="checkmark" size={12} tintColor="#ffffff" type="monochrome" />
          )}
          <AppText className="font-t3-medium text-xs text-white tabular-nums">{label}</AppText>
        </View>
        {saving && props.media.progress !== null ? (
          <View className="h-0.5 bg-white/20">
            <View className="h-full bg-white" style={{ width: `${props.media.progress}%` }} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}
