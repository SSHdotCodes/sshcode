// Kept free of imports: the Home list item union (sessionBoxListItems) and the
// Discord list builder both need it, and the builder imports that union.
export const DISCORD_CATEGORIES = [
  "Pinned",
  "Needs you",
  "Working",
  "Chats",
  "Snoozed",
  "Settled",
] as const;
export type DiscordCategory = (typeof DISCORD_CATEGORIES)[number];
export interface DiscordHeading {
  readonly type: "discord-heading";
  readonly key: string;
  readonly label: DiscordCategory;
  readonly count: number;
  readonly expanded: boolean;
}
