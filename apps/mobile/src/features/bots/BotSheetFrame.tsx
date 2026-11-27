import { useNavigation } from "@react-navigation/native";
import { useId, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { withUniwind } from "uniwind";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const NativeScreen = withUniwind(Screen);
const NativeHeader = withUniwind(ScreenStackHeaderConfig, {
  color: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
  titleColor: { fromClassName: "titleColorClassName", styleProperty: "accentColor" },
});

/**
 * A bot sheet route's frame. A formSheet route never draws a stack header, so iOS gets one
 * from a nested native stack (like the Agents sheet), with one trailing button.
 */
export function BotSheetFrame(props: {
  readonly title: string;
  readonly children: ReactNode;
  /** The trailing button; defaults to Done, which closes the sheet. */
  readonly action?: {
    readonly label: string;
    readonly onPress: () => void;
    readonly disabled?: boolean;
  };
}) {
  const navigation = useNavigation();
  const screenId = useId();
  const action = props.action ?? { label: "Done", onPress: () => navigation.goBack() };
  if (Platform.OS !== "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <AndroidSheetHeader title={props.title} onBack={() => navigation.goBack()} />
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
          {props.children}
        </KeyboardAvoidingView>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenStack style={{ flex: 1 }}>
        <NativeScreen
          activityState={2}
          enabled
          isNativeStack
          screenId={`bot-sheet-${screenId}`}
          scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
          className="flex-1 bg-sheet"
        >
          <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
            {props.children}
          </KeyboardAvoidingView>
          <NativeHeader
            backgroundColor="rgba(0,0,0,0)"
            tintColorClassName="accent-foreground"
            hideBackButton
            hideShadow={false}
            title={props.title}
            titleColorClassName="accent-foreground"
            titleFontSize={18}
            titleFontWeight="800"
            translucent
            headerRightBarButtonItems={[
              {
                type: "button",
                title: action.label,
                variant: "done",
                disabled: action.disabled === true,
                accessibilityLabel: action.label,
                identifier: `bot-sheet-action-${screenId}`,
                onPress: action.onPress,
              },
            ]}
          />
        </NativeScreen>
      </ScreenStack>
    </View>
  );
}
