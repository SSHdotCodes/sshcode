import type { ReactNode } from "react";
import { Platform, useWindowDimensions, View } from "react-native";

import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName, type SFSymbol } from "./AppSymbol";

/** A tile shows the filled glyph where SF Symbols has one, as the Settings app does. */
const FILLED_ON_TILE: Partial<Record<string, SFSymbol>> = {
  archivebox: "archivebox.fill",
  "bell.badge": "bell.badge.fill",
  binoculars: "binoculars.fill",
  clock: "clock.fill",
  cloud: "cloud.fill",
  folder: "folder.fill",
  hammer: "hammer.fill",
  "info.circle": "info.circle.fill",
  keyboard: "keyboard.fill",
  mic: "mic.fill",
  paintpalette: "paintpalette.fill",
  "person.crop.circle": "person.crop.circle.fill",
  star: "star.fill",
  "text.bubble": "text.bubble.fill",
};

function tileSymbol(icon: AppSymbolName): AppSymbolName {
  const filled = typeof icon === "string" ? FILLED_ON_TILE[icon] : FILLED_ON_TILE[icon.ios];
  // Tiles are drawn on iOS only, so the Android name is never read.
  return filled ? { ios: filled, android: "check" } : icon;
}

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  /**
   * On iOS, sets the icon white on a small rounded tile of this colour, as the system
   * Settings app draws its rows.
   */
  readonly iconTint?: string;
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

/** Shared row geometry; controls own their behavior and accessibility. */
export function ListRowLayout({
  icon,
  iconTint,
  leading,
  label,
  description,
  detail,
  disabled,
  accessory,
}: ListRowContentProps & { readonly accessory?: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  // Leave the label room to wrap at accessibility text sizes.
  const stackDetail = fontScale >= 1.5;
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        description && "min-h-18",
        disabled && "opacity-45",
      )}
    >
      {leading}
      {icon && iconTint && Platform.OS === "ios" ? (
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            borderCurve: "continuous",
            backgroundColor: iconTint,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView
            name={tileSymbol(icon)}
            size={17}
            tintColor="#ffffff"
            type="monochrome"
            weight="medium"
          />
        </View>
      ) : icon ? (
        <View className="size-6 items-center justify-center">
          <SymbolView
            name={icon}
            size={Platform.OS === "android" ? 24 : 22}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText className="text-base text-foreground">{label}</AppText>
        {description ? (
          <AppText className="text-sm text-foreground-muted">{description}</AppText>
        ) : null}
        {detail && stackDetail ? (
          <AppText className="text-sm text-foreground-muted">{detail}</AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          className="max-w-[40%] shrink text-right text-sm text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
}
