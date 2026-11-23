import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { ExpandableText } from "../settings/ExpandableText";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";

/** `source` names the failure the error came from, so a later one with the same text differs. */
export function getThreadErrorBannerKey(
  threadKey: string,
  error: string | null,
  source: string | null = null,
): string | null {
  return error === null ? null : `${threadKey}\u0000${source ?? ""}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key, failure and message, so navigating away to a
// thread with no error cannot resurrect the banner, while a different error,
// or a later failure with the same message, on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

/**
 * Whether the transcript already shows this failure as a row of its own. The
 * floating banner then only repeats the sentence, over the transcript's first
 * lines. Only the tail is read: a thread's error is about its latest turn.
 */
export function isThreadErrorShownInTimeline(
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly entry?: { readonly detail?: string; readonly sourceActivityKind?: string };
  }>,
  error: string | null,
): boolean {
  const text = error?.trim();
  if (!text) return false;
  for (let index = entries.length - 1; index >= Math.max(0, entries.length - 40); index -= 1) {
    const entry = entries[index]!;
    if (
      entry.kind === "work" &&
      entry.entry?.sourceActivityKind === "runtime.error" &&
      entry.entry.detail?.trim() === text
    ) {
      return true;
    }
  }
  return false;
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  errorClass,
  chatGptUsageLimit = false,
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  onDismiss?: () => void;
  chatGptUsageLimit?: boolean;
}) {
  if (!error) return null;
  const variant = errorClass === "usage_limit" ? "warning" : "error";
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(var(--chat-content-max-width),calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="glass" controlAlignment="first-line" data-variant={variant}>
        {chatGptUsageLimit ? (
          <OpenAI className="size-4 text-foreground!" aria-hidden="true" />
        ) : (
          <CircleAlertIcon />
        )}
        <AlertDescription>
          {chatGptUsageLimit ? (
            <div className="space-y-1">
              <p className="font-medium">ChatGPT usage limit reached</p>
              <p>Review your usage settings in ChatGPT to continue.</p>
            </div>
          ) : (
            <ExpandableText text={error} className="select-text" />
          )}
        </AlertDescription>
        {(chatGptUsageLimit || onDismiss) && (
          <AlertAction>
            {chatGptUsageLimit ? <ChatGptUsageButton variant="default" size="sm" /> : null}
            {onDismiss ? (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
