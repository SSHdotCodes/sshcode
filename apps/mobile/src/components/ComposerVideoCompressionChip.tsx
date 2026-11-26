import { View } from "react-native";

import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";

export function ComposerVideoCompressionChip({ name }: { readonly name: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${name}, Compressing`}
      accessibilityState={{ busy: true }}
      accessibilityLiveRegion="polite"
      className="h-14 w-40 flex-row items-center gap-2 rounded-xl border border-border-subtle bg-card px-2.5"
    >
      <SymbolView name="play" size={16} tintColorClassName="accent-icon-muted" />
      <View className="min-w-0 flex-1">
        <AppText className="text-xs text-foreground" numberOfLines={1} ellipsizeMode="middle">
          {name}
        </AppText>
        <AppText className="text-2xs text-foreground-muted" numberOfLines={1}>
          Compressing…
        </AppText>
      </View>
    </View>
  );
}
