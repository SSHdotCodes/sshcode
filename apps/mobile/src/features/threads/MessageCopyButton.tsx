import { useContext } from "react";
import { MessageMenuContext } from "../../native/MessageMenuContext";
import type { MenuAction } from "@react-native-menu/menu";
import type { ColorValue } from "react-native";
import { Alert } from "react-native";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";

import { ControlPillMenu } from "../../components/ControlPill";
import { CopyTextButton } from "../../components/CopyTextButton";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyPromptLink } from "../prompt-links/prompt-link-actions";
import { messageQuoteText } from "./messageQuote";

/** Tap to copy as usual; hold for reply and Markdown actions. */
export function MessageCopyButton(props: {
  readonly text: string;
  readonly onCopy?: (() => Promise<void>) | undefined;
  readonly onQuote?: ((text: string) => void) | undefined;
  readonly promptLink?: boolean;
  readonly tintColor: ColorValue;
}) {
  const messageActions = useContext(MessageMenuContext);
  if (props.text.trim().length === 0) return null;
  const linkText = messageQuoteText(props.text);
  const actions = [
    ...messageActions.map((action, index) => ({
      id: `message-action:${index}`,
      title: action.text,
      image: action.icon,
    })),
    { id: "copy-markdown", title: "Copy Markdown", image: "doc.on.doc" },
    ...(props.onQuote ? [{ id: "quote", title: "Quote in reply", image: "text.quote" }] : []),
    ...(props.promptLink && linkText.length <= PROMPT_LINK_MAX_PROMPT_LENGTH
      ? [{ id: "copy-prompt-link", title: "Copy prompt link", image: "link" }]
      : []),
  ] satisfies MenuAction[];
  const handleAction = (action: string) => {
    if (action.startsWith("message-action:")) messageActions[Number(action.slice(15))]?.onPress();
    if (action === "quote") props.onQuote?.(props.text);
    if (action === "copy-prompt-link") void copyPromptLink(linkText);
    if (action === "copy-markdown") {
      void tryCopyTextWithHaptic(props.text).then((copied) => {
        if (!copied) Alert.alert("Could not copy", "Try again.");
      });
    }
  };
  return (
    <ControlPillMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => handleAction(nativeEvent.event)}
      shouldOpenOnLongPress
    >
      <CopyTextButton
        accessibilityLabel="Copy message"
        accessibilityHint="Touch and hold for message actions"
        accessibilityActions={actions.map((action) => ({ name: action.id, label: action.title }))}
        onAccessibilityAction={(event) => handleAction(event.nativeEvent.actionName)}
        text={props.text}
        onCopy={props.onCopy}
        tintColor={props.tintColor}
        buttonSize={28}
        iconSize={13}
      />
    </ControlPillMenu>
  );
}
