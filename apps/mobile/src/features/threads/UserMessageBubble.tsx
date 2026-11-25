import type { ComponentProps } from "react";
import { View } from "react-native";

export function UserMessageBubble(props: ComponentProps<typeof View>) {
  return (
    <View {...props} className="min-w-0 gap-2 rounded-[20px] border-continuous px-3.5 py-2.5" />
  );
}
