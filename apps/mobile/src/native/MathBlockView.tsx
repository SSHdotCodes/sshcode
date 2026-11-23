import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import type { TypesetMathBlock } from "../lib/mathTypeset";

import { mathDocument } from "../lib/mathDocument";

export function MathBlockView({
  block,
  color,
  fontSize,
  lineHeight,
  linkColor,
  onLinkPress,
  fontFamily,
  preserveSoftBreaks,
}: {
  block: TypesetMathBlock;
  color: string;
  fontSize: number;
  lineHeight: number;
  linkColor: string;
  onLinkPress?: (url: string) => void;
  fontFamily: string;
  preserveSoftBreaks: boolean;
}) {
  const [height, setHeight] = useState(0);
  const [failed, setFailed] = useState(false);
  const html = useMemo(
    () =>
      mathDocument(
        block.html,
        color,
        fontSize,
        lineHeight,
        linkColor,
        fontFamily,
        preserveSoftBreaks,
      ),
    [block.html, color, fontSize, lineHeight, linkColor, fontFamily, preserveSoftBreaks],
  );
  const source = useMemo(() => ({ html }), [html]);
  return (
    <View style={{ minWidth: 0, width: "100%" }}>
      {(failed || height === 0) && (
        <Text style={{ color, fontSize, lineHeight }}>{block.source}</Text>
      )}
      {!failed && (
        <WebView
          source={source}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
          onMessage={(event) => {
            try {
              const message: { height?: unknown; link?: unknown } = JSON.parse(
                event.nativeEvent.data,
              );
              if (typeof message.link === "string" && /^https?:\/\//i.test(message.link))
                onLinkPress?.(message.link);
              const value = message.height;
              if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                if (value > 4000) setFailed(true);
                else setHeight(value);
              }
            } catch {
              /* Keep the source fallback for invalid messages. */
            }
          }}
          onError={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
          scrollEnabled={false}
          automaticallyAdjustContentInsets={false}
          style={{ height: height || 1, opacity: height ? 1 : 0, backgroundColor: "transparent" }}
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy equation source"
        onPress={() => copyTextWithHaptic(block.source)}
        style={{ alignSelf: "flex-end", paddingHorizontal: 4 }}
      >
        <Text style={{ color, fontSize: 11 }}>Copy</Text>
      </Pressable>
    </View>
  );
}
