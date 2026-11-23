import type { ReactNode } from "react";

export function UserMessageBubble({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
      data-user-message-bubble
    >
      {children}
    </div>
  );
}
