/** Approval-only annotations. The original string is retained for dispatch. */
export function visibleGuestPrompt(text: string) {
  const characters = [...text];
  const pictograph = /\p{Extended_Pictographic}/u;
  const modifier = /\p{Emoji_Modifier}/u;
  const emojiBefore = (index: number) => {
    let previous = index - 1;
    while (
      previous >= 0 &&
      (modifier.test(characters[previous]!) || /[\uFE0E\uFE0F]/u.test(characters[previous]!))
    )
      previous--;
    return previous >= 0 && pictograph.test(characters[previous]!);
  };
  let controlCharacterCount = 0;
  const visible = characters
    .map((character, index) => {
      if (/[\n\r\t]/u.test(character)) return character;
      if (
        character === "\u200D" &&
        emojiBefore(index) &&
        pictograph.test(characters[index + 1] ?? "")
      )
        return character;
      if (
        /[\uFE0E\uFE0F]/u.test(character) &&
        (emojiBefore(index) ||
          (/[#*0-9]/u.test(characters[index - 1] ?? "") && characters[index + 1] === "\u20E3"))
      )
        return character;
      if (!/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u.test(character))
        return character;
      controlCharacterCount++;
      return `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`;
    })
    .join("");
  return { text: visible, controlCharacterCount };
}
