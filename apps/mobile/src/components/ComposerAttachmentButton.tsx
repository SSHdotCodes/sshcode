import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const MEDIA_MENU_ACTIONS: MenuAction[] = [{ id: "photos", title: "Photo Library", image: "photo" }];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onScheduleMessage?: () => void;
  readonly scheduleUnavailableReason?: string | null;
  readonly onPickCamera?: () => Promise<void>;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  /** Absent hides the switch. On unless the chat has turned subagents off. */
  readonly subagentsEnabled?: boolean;
  readonly onSubagentsChange?: (enabled: boolean) => void;
  /** Opens the chat's Agents view, where the user can also start a subagent. Absent hides it. */
  readonly onOpenAgents?: () => void;
}) {
  const { scale } = useAndroidControlSizing();
  const showsMenu =
    props.supportsFiles ||
    props.onPickCamera !== undefined ||
    props.onScheduleMessage !== undefined ||
    props.onSubagentsChange !== undefined ||
    props.onOpenAgents !== undefined;
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={showsMenu ? undefined : () => void props.onPickMedia()}
    >
      <SymbolView
        name="plus"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || !showsMenu) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={[
        ...MEDIA_MENU_ACTIONS,
        ...(props.onScheduleMessage
          ? [
              {
                id: "schedule",
                title: props.scheduleUnavailableReason
                  ? "Schedule Message (Update Server)"
                  : "Schedule Message…",
                image: "calendar.badge.clock",
                attributes: { disabled: props.scheduleUnavailableReason != null },
              },
            ]
          : []),
        ...(props.onPickCamera ? [{ id: "camera", title: "Take Photo", image: "camera" }] : []),
        ...(props.supportsFiles ? [{ id: "files", title: "Choose Files", image: "folder" }] : []),
        ...(props.onOpenAgents ? [{ id: "agents", title: "Agents", image: "person.3" }] : []),
        ...(props.onSubagentsChange
          ? [
              {
                id: "subagents",
                title: props.subagentsEnabled === false ? "Subagents Off" : "Subagents On",
                image: "person.2",
                state: props.subagentsEnabled === false ? ("off" as const) : ("on" as const),
              },
            ]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "schedule") {
          props.onScheduleMessage?.();
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "camera") {
          void props.onPickCamera?.();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        } else if (nativeEvent.event === "agents") {
          props.onOpenAgents?.();
        } else if (nativeEvent.event === "subagents") {
          props.onSubagentsChange?.(props.subagentsEnabled === false);
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
