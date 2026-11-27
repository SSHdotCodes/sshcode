import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { LiveProgressCardBody } from "./LiveProgress";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type ProgressTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** The working pill opens this: the full card for the chat, live while it works. */
export function ThreadProgressSheet({ route }: StaticScreenProps<ProgressTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const theme = useUniwindTheme();
  const { layout } = useAdaptiveWorkspaceLayout();
  const shell = useThreadShell(scopeThreadRef(target.environmentId, target.threadId));
  const progress = shell?.source.liveProgress;
  const content: ReactNode = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-5 pt-3 pb-10"
    >
      {progress === undefined ? (
        <Text className="text-sm text-foreground-muted">
          {shell === null ? "This chat is not available." : "No progress to show right now."}
        </Text>
      ) : (
        <LiveProgressCardBody progress={progress} fallbackTitle={shell?.title ?? "Working"} />
      )}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the queue sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-progress-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Progress"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Progress" onBack={() => navigation.goBack()} />
      <MaterialScreenContent insetHorizontal={layout.usesSplitView}>
        {content}
      </MaterialScreenContent>
    </View>
  );
}
