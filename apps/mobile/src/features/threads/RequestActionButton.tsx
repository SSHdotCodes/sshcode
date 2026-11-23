import { useUiMode } from "../discord/useUiMode";
import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Primary actions in the cards that replace the thread composer. */
export function RequestActionButton({
  label,
  tone = "primary",
  size = "default",
  disabled,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style"> & {
  label: string;
  tone?: "primary" | "secondary" | "danger" | "success";
  size?: "default" | "large";
}) {
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ ...props.accessibilityState, disabled: Boolean(disabled) }}
      disabled={disabled}
      style={
        discord
          ? {
              borderRadius: 4,
              backgroundColor:
                tone === "success"
                  ? "#248046"
                  : tone === "danger"
                    ? "#DA373C"
                    : tone === "primary"
                      ? "#5865F2"
                      : "#4E5058",
            }
          : undefined
      }
      className={cn(
        "min-h-[44px] min-w-[44px] items-center justify-center active:opacity-70 disabled:opacity-50",
        size === "large" ? "rounded-2xl px-4 py-3.5" : "rounded-[14px] px-3.5 py-3",
        tone === "primary" || tone === "success"
          ? "bg-primary"
          : tone === "danger"
            ? "bg-danger"
            : "bg-subtle-strong",
      )}
    >
      <Text
        style={discord ? { color: "#FFFFFF", fontWeight: "600" } : undefined}
        className={cn(
          "text-sm",
          tone === "primary"
            ? "font-t3-extrabold text-primary-foreground"
            : tone === "danger"
              ? "font-t3-bold text-danger-foreground"
              : "font-t3-bold text-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
