import type { ImageSourcePropType } from "react-native";

export const CONTEXT_CHIP_ICON_SOURCES = {
  bot: require("../../assets/context-chip-icons/bot.png"),
  "link-github": require("../../assets/context-chip-icons/link-github.png"),
  "link-huggingface": require("../../assets/context-chip-icons/link-huggingface.png"),
} as const satisfies Readonly<Record<string, ImageSourcePropType>>;

export const PROVIDER_CHIP_ICONS: Readonly<
  Record<string, { readonly source: ImageSourcePropType; readonly tintsIcon: boolean }>
> = {
  claudeAgent: {
    source: require("../../assets/context-chip-icons/provider-claudeAgent.png"),
    tintsIcon: false,
  },
  codex: {
    source: require("../../assets/context-chip-icons/provider-codex.png"),
    tintsIcon: true,
  },
  cursor: {
    source: require("../../assets/context-chip-icons/provider-cursor.png"),
    tintsIcon: true,
  },
  grok: {
    source: require("../../assets/context-chip-icons/provider-grok.png"),
    tintsIcon: true,
  },
  muse: {
    source: require("../../assets/context-chip-icons/provider-muse.png"),
    tintsIcon: false,
  },
  opencode: {
    source: require("../../assets/context-chip-icons/provider-opencode.png"),
    tintsIcon: true,
  },
  pi: {
    source: require("../../assets/context-chip-icons/provider-pi.png"),
    tintsIcon: true,
  },
  antigravity: { source: require("../../assets/antigravity.png"), tintsIcon: false },
};
