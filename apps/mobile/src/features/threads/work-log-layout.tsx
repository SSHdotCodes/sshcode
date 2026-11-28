import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { THREAD_WORK_ROW_MIN_HEIGHT, type deriveThreadWorkLogSizing } from "../../lib/layout";

export function WorkLogBlock({
  children,
  layout = "standalone",
  continues = false,
}: {
  children: ReactNode;
  layout?: "standalone" | "group-header";
  continues?: boolean | undefined;
}) {
  return (
    <View className={continues || layout === "group-header" ? "-mx-1 px-1" : "-mx-1 mb-1 px-1"}>
      {children}
    </View>
  );
}

export function WorkLogRows({ children }: { children: ReactNode }) {
  return <View className="gap-px">{children}</View>;
}

export function WorkLogIconSlot({ children }: { children: ReactNode }) {
  return <View className="relative h-6 w-6 shrink-0 items-center justify-center">{children}</View>;
}

/** Consumers supply actions/content; sizing comes from the feed's accessibility-aware metrics. */
export function WorkLogPressable({
  children,
  rowSizing,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style" | "hitSlop"> & {
  children: ReactNode;
  rowSizing?: ReturnType<typeof deriveThreadWorkLogSizing>;
}) {
  return (
    <Pressable
      {...props}
      hitSlop={4}
      className={cn(
        "rounded-lg border-continuous px-0.5 active:bg-subtle-strong",
        props.accessibilityState?.expanded && "bg-subtle",
      )}
    >
      <View
        className="flex-row items-center gap-1.5"
        style={{ minHeight: rowSizing?.estimatedRowHeight ?? THREAD_WORK_ROW_MIN_HEIGHT }}
      >
        {children}
      </View>
    </Pressable>
  );
}

/** Headers stay one line, unless a row asks for more; detail content wraps separately. */
export function WorkLogLabel({
  children,
  tone = "default",
  ellipsizeMode = "tail",
  emphasized = false,
  lines = 1,
}: {
  children: ReactNode;
  tone?: "default" | "danger" | "warning";
  ellipsizeMode?: "head" | "tail";
  emphasized?: boolean;
  lines?: number;
}) {
  return (
    <Text
      selectable={false}
      numberOfLines={lines}
      ellipsizeMode={ellipsizeMode}
      className={cn(
        "min-w-0 flex-1 text-sm text-foreground-muted",
        emphasized && "font-t3-medium text-foreground",
        tone === "danger" && "font-t3-medium text-adaptive-rose-600-400",
        tone === "warning" && "font-t3-medium text-warning-foreground",
      )}
    >
      {children}
    </Text>
  );
}
