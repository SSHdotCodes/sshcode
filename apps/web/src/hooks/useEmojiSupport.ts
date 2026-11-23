import { useEffect, useState } from "react";
import { hasEmojiShortcode } from "@t3tools/shared/emoji";

type EmojiMarkdown = typeof import("@t3tools/shared/emojiMarkdown");
let support: Promise<EmojiMarkdown> | undefined;

export function useEmojiSupport(text: string): EmojiMarkdown | null {
  const [emoji, setEmoji] = useState<EmojiMarkdown | null>(null);
  const needsEmoji = hasEmojiShortcode(text);
  useEffect(() => {
    if (!needsEmoji || emoji) return;
    let active = true;
    (support ??= import("@t3tools/shared/emojiMarkdown"))
      .then((module) => {
        if (active) setEmoji(module);
      })
      .catch(() => {
        support = undefined;
      });
    return () => {
      active = false;
    };
  }, [emoji, needsEmoji]);
  return emoji;
}
