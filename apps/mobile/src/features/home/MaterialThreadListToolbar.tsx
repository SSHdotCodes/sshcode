import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  BackHandler,
  Keyboard,
  type TextInputInstance,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";

/** One toolbar height for the compact list and expanded sidebar, including search. */
export function MaterialThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const { height: toolbarHeight, ...headerPadding } = useMaterialToolbarLayout();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  const searchField = (
    <MaterialSearchField
      inputRef={searchRef}
      accessibilityLabel="Search chats"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );

  return (
    <View
      onLayout={props.onLayout}
      className={props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"}
      style={headerPadding}
    >
      <View className="flex-row items-center gap-1" style={{ minHeight: toolbarHeight }}>
        {searching ? (
          <>
            <AndroidHeaderIconButton
              accessibilityLabel="Close search"
              icon="arrow.left"
              onPress={closeSearch}
            />
            {searchField}
          </>
        ) : (
          <>
            {/* Match the visible inset of the trailing 48dp icon button. */}
            <View className="min-w-0 flex-1 pl-4">
              <WorkspaceConnectionTitle
                grow
                onPress={props.onOpenEnvironments}
                brand={<CompactBrandTitle allowFontScaling={false} />}
              />
            </View>
            <AndroidHeaderIconButton
              accessibilityLabel="Search chats"
              icon="magnifyingglass"
              onPress={openSearch}
            />
            <AndroidHeaderIconButton
              accessibilityLabel="Open settings"
              icon="gearshape"
              onPress={props.onOpenSettings}
            />
          </>
        )}
      </View>
    </View>
  );
}
