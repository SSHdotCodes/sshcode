import { createContext, use } from "react";

const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  semibold: "DMSans-SemiBold",
  bold: "DMSans-Bold",
} as const;

/** Discord mode sets this from the appearance provider: it uses the system font. */
export const SystemFontContext = createContext(false);

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 */
export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  return use(SystemFontContext) ? "System" : FONT_FAMILIES[weight];
}
