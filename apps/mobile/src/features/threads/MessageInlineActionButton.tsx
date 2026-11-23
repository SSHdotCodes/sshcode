import { useContext } from "react";
import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { MessageMenuContext } from "../../native/MessageMenuContext";

/**
 * The message action marked inline (edit and resend after a stop), as a pencil
 * beside the copy button. Long-press on the bubble selects text, so the menu
 * alone is too hidden for it.
 */
export function MessageInlineActionButton(props: { readonly tintColor: ColorValue }) {
  const action = useContext(MessageMenuContext).find((candidate) => candidate.inline);
  if (action === undefined) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.text}
      hitSlop={8}
      className="size-7 items-center justify-center"
      onPress={action.onPress}
    >
      <SymbolView name="pencil" size={14} tintColor={props.tintColor} />
    </Pressable>
  );
}
