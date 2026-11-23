import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { use, useCallback, useEffect, useRef } from "react";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Platform } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { createSidebarHeaderItems } from "../threads/sidebar-native-header-items";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export function HomeHeader(props: HomeHeaderProps) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const primaryColumn = use(NativePrimaryColumnContext);
  const sidebarHeader =
    Platform.OS === "ios" &&
    primaryColumn !== null &&
    (Platform.isPad || !usesNativeMailSearchToolbar);
  const showsCompactCompose = Platform.OS === "ios" && Platform.isPad && !layout.usesSplitView;
  const searchBarRef = useRef<SearchBarCommands>(null);
  const focusAfterReveal = useRef(false);
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (event) => {
        if (focusAfterReveal.current && !event.data.closing) {
          focusAfterReveal.current = false;
          searchBarRef.current?.focus();
        }
      }),
    [navigation],
  );
  const iconColor = useUniwindTheme()["--color-icon"];
  const focusSearch = useCallback(() => {
    if (primaryColumn && !panes.primarySidebarVisible) {
      focusAfterReveal.current = true;
      togglePrimarySidebar();
      return true;
    }
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, [primaryColumn, panes.primarySidebarVisible, togglePrimarySidebar]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);

  if (props.usesWorkspaceToolbar) {
    return null;
  }

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={showsCompactCompose}
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems: () =>
            sidebarHeader
              ? [
                  ...createSidebarHeaderItems({ onOpenSettings: props.onOpenSettings }),
                  ...(showsCompactCompose
                    ? [
                        withNativeGlassHeaderItem({
                          accessibilityLabel: "New chat",
                          axisBehavior: "horizontalOnly",
                          icon: { name: "square.and.pencil", type: "sfSymbol" } as const,
                          identifier: "home-new-task",
                          label: "",
                          onPress: props.onStartNewTask,
                          type: "button",
                        }),
                      ]
                    : []),
                ]
              : [
                  withNativeGlassHeaderItem({
                    accessibilityLabel: "Open settings",
                    icon: { name: "ellipsis", type: "sfSymbol" } as const,
                    identifier: "home-settings",
                    label: "",
                    onPress: props.onOpenSettings,
                    type: "button",
                  }),
                ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by NativeHeaderToolbar.
          ...(sidebarHeader
            ? {
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked" as const,
                  allowToolbarIntegration: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => props.onSearchQueryChange(""),
                  onChangeText: (event) => props.onSearchQueryChange(event.nativeEvent.text),
                },
                unstable_headerToolbarItems: () => [],
              }
            : usesNativeMailSearchToolbar
              ? {
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    onCancelButtonPress: () => props.onSearchQueryChange(""),
                  },
                  unstable_headerToolbarItems: () => [
                    createNativeMailSearchToolbarItem({
                      composeButtonId: "home-new-task",
                      composeSystemImageName: "square.and.pencil",
                      onComposePress: props.onStartNewTask,
                      onSearchTextChange: props.onSearchQueryChange,
                      placeholder: "Search",
                      searchTextChangeId: "home-search-text",
                      showsSearchDismissButton: true,
                    }),
                  ],
                }
              : {
                  // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                  // bar; create lives in the plain bottom toolbar below.
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    hideNavigationBar: false,
                    placeholder: "Search",
                    onCancelButtonPress: () => {
                      props.onSearchQueryChange("");
                    },
                    onChangeText: (event) => {
                      props.onSearchQueryChange(event.nativeEvent.text);
                    },
                  },
                }),
        }}
      />

      {sidebarHeader || usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Spacer flexible />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New chat"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
