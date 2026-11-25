import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { AppText as Text } from "./AppText";

export function ListSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
  /** Inset hairlines between direct rows on iOS. */
  readonly separated?: boolean;
}) {
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <View
            className={
              Platform.OS === "android"
                ? "min-w-0 flex-1 flex-row items-center gap-2 px-4"
                : "min-w-0 flex-1 flex-row items-center gap-2 px-2"
            }
          >
            {props.titleIcon}
            <Text
              accessibilityRole="header"
              className="shrink text-sm font-t3-medium text-foreground-muted"
            >
              {props.title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "overflow-hidden rounded-[28px] bg-grouped-card"
            : "overflow-hidden rounded-[24px] border-continuous bg-grouped-card"
        }
      >
        {props.separated && Platform.OS === "ios"
          ? Children.toArray(props.children).map((child, index) => (
              <Fragment key={isValidElement(child) ? (child.key ?? index) : index}>
                {index > 0 ? (
                  <View
                    pointerEvents="none"
                    className="bg-border-subtle"
                    style={{ height: StyleSheet.hairlineWidth, marginStart: 55, marginEnd: 14 }}
                  />
                ) : null}
                {child}
              </Fragment>
            ))
          : props.children}
      </View>
      {props.footer ? (
        // Same inset as the section title above, and as the footnotes that
        // screens write under a section themselves.
        <Text
          className={
            Platform.OS === "android"
              ? "px-4 text-sm text-foreground-muted"
              : "px-2 text-sm text-foreground-muted"
          }
        >
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}
