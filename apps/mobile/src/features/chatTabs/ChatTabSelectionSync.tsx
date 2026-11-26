import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ALL_CHATS_TAB } from "@t3tools/client-runtime/state/chat-tabs";
import { AsyncResult } from "effect/reactivity";
import { use, useEffect } from "react";
import { LayoutAnimation } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { chatListTabsEnabledAtom } from "../../state/server";

/** A remote edit also clears the saved folder while Home is behind another screen. */
export function ChatTabSelectionSync() {
  const enabled = useAtomValue(chatListTabsEnabledAtom);
  const selected = useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result) ? result.value.threadListChatTab : undefined,
  );
  const save = useAtomSet(updateMobilePreferencesAtom);
  useEffect(() => {
    if (enabled === false && selected) save({ threadListChatTab: ALL_CHATS_TAB });
  }, [enabled, selected, save]);

  const reducedMotion = useReducedMotion();
  const registry = use(RegistryContext);
  useEffect(() => {
    if (reducedMotion) return;
    let visible = registry.get(chatListTabsEnabledAtom) !== false;
    return registry.subscribe(chatListTabsEnabledAtom, (value) => {
      const next = value !== false;
      if (next !== visible) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      visible = next;
    });
  }, [reducedMotion, registry]);
  return null;
}
