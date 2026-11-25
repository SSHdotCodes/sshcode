import { useId, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppText } from "../components/AppText";
import {
  canFoldUserMessage,
  USER_MESSAGE_FOLDED_LINES,
  USER_MESSAGE_THRESHOLD_LINES,
} from "./userMessageDisclosure.logic";

export interface UserMessageDisclosureProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly fadeColor: string;
  readonly linkColor: string;
}

export function UserMessageDisclosure(
  props: UserMessageDisclosureProps & {
    readonly children: ReactNode;
    readonly renderText: (lines: number, measuring?: boolean) => ReactNode;
    readonly lineHeight: number;
  },
) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { fontScale } = useWindowDimensions();
  const onLayout = ({ nativeEvent: { layout: next } }: LayoutChangeEvent) =>
    setLayout((previous) =>
      previous.width === next.width && previous.height === next.height
        ? previous
        : { width: next.width, height: next.height },
    );
  return (
    <View onLayout={onLayout} style={{ minWidth: 84 }}>
      <MeasuredUserMessage
        {...props}
        key={`${layout.width}:${fontScale}`}
        width={layout.width}
        // Ordinary Markdown lines use at least this much space. Most user messages need no probes.
        tallEnough={layout.height >= props.lineHeight * fontScale * USER_MESSAGE_FOLDED_LINES}
      />
    </View>
  );
}

function MeasuredUserMessage(
  props: Parameters<typeof UserMessageDisclosure>[0] & {
    readonly width: number;
    readonly tallEnough: boolean;
  },
) {
  const gradientId = `message-fade-${useId().replaceAll(":", "")}`;
  const [naturalHeight, setNaturalHeight] = useState<number>();
  const [thresholdHeight, setThresholdHeight] = useState<number>();
  const onMeasured = (setter: (height: number) => void) => (event: LayoutChangeEvent) =>
    setter(event.nativeEvent.layout.height);
  const measured = naturalHeight !== undefined && thresholdHeight !== undefined;
  const foldable = measured && canFoldUserMessage(naturalHeight, thresholdHeight);
  const collapsed = foldable && !props.expanded;

  return (
    <>
      <View style={collapsed ? { width: props.width, maxWidth: "100%" } : undefined}>
        {collapsed ? props.renderText(USER_MESSAGE_FOLDED_LINES) : props.children}
        {collapsed ? (
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={props.onToggle}
            className="absolute inset-x-0 bottom-0 h-7"
          >
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
                    <Stop offset={0} stopColor={props.fadeColor} stopOpacity={0} />
                    <Stop offset={1} stopColor={props.fadeColor} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            </View>
          </Pressable>
        ) : null}
      </View>
      {props.width > 0 && props.tallEnough && !measured ? (
        // Probe at the bubble's real width using the same native layout as the clamped preview.
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", top: 0, width: props.width, opacity: 0 }}
        >
          <View onLayout={onMeasured(setNaturalHeight)}>{props.renderText(0, true)}</View>
          <View onLayout={onMeasured(setThresholdHeight)}>
            {props.renderText(USER_MESSAGE_THRESHOLD_LINES, true)}
          </View>
        </View>
      ) : null}
      {foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="min-h-11 items-end justify-center active:opacity-70"
        >
          <AppText className="text-xs font-t3-medium" style={{ color: props.linkColor }}>
            {props.expanded ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
    </>
  );
}
