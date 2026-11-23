import {
  activeProviderFailure,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatOutOfCredit, formatProviderResetTime } from "@t3tools/client-runtime/providerHealth";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ExpandableText } from "../settings/ExpandableText";

/** Unsupported and broken versions fail mid-turn, so they warn even when ready. */
function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

/**
 * A usage limit a run hit, while it lasts. Not shown in a chat already showing its own
 * failure: there the chat's limit notice says it with the resume controls.
 */
function getUsageLimitHit(
  status: ServerProvider,
  showRecentFailure: boolean,
  now: number,
  model?: string,
) {
  if (status.status !== "ready") return null;
  if (status.recentFailure?.outOfCredit) return status.recentFailure;
  if (!showRecentFailure) return null;
  const failure = activeProviderFailure(status, now, model);
  return failure?.kind === "usage_limit" ? failure : null;
}

export function getProviderStatusBannerKey(
  status: ServerProvider | null,
  options: {
    readonly showRecentFailure?: boolean;
    readonly model?: string | undefined;
    readonly now?: number;
  } = {},
): string | null {
  if (!status || status.status === "disabled") return null;
  const limitHit = getUsageLimitHit(
    status,
    options.showRecentFailure ?? false,
    options.now ?? Date.now(),
    options.model,
  );
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (limitHit) {
    return [status.instanceId, "usage_limit", limitHit.occurredAt].join("\u0000");
  }
  if (status.status === "ready") return null;
  // Antigravity checks saved credentials when a session starts. Its local
  // health check leaves auth unknown after a restart, which is not a failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
  options: {
    readonly showRecentFailure?: boolean;
    readonly model?: string | undefined;
    readonly now?: number;
  } = {},
): boolean {
  const bannerKey = getProviderStatusBannerKey(status, options);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Broken-version guidance takes precedence over startup failures it can cause. */
export function getProviderStatusMessage(status: ServerProvider): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  showRecentFailure = false,
  model,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  /** Also warn about a usage limit a run hit (see `getUsageLimitHit`). */
  showRecentFailure?: boolean;
  model?: string | undefined;
  status: ServerProvider | null;
}) {
  const now = Date.parse(`${useNowMinute()}Z`);
  if (!status || getProviderStatusBannerKey(status, { showRecentFailure, model, now }) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const incompatible = getIncompatibleVersion(status);
  const limitHit = incompatible ? null : getUsageLimitHit(status, showRecentFailure, now, model);
  const title = limitHit?.outOfCredit
    ? formatOutOfCredit(limitHit)
    : isUnauthenticated
      ? `${providerName} is unauthenticated`
      : incompatible
        ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
        : limitHit
          ? limitHit.resetAt
            ? `${providerName} is at its usage limit until ${formatProviderResetTime(limitHit.resetAt, now)}`
            : `${providerName} is at its usage limit`
          : `${providerName} provider status`;
  const message = limitHit?.outOfCredit
    ? ""
    : (incompatible?.message ?? limitHit?.message ?? getProviderStatusMessage(status));
  const isWarning =
    incompatible?.status !== "broken" &&
    (status.status === "warning" || incompatible !== null || limitHit !== null);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={isWarning ? "warning" : "error"}
        role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <ExpandableText text={message} className="select-text" />
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
              Open provider setup
            </InlineButton>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Dismiss ${providerName} provider ${status.status}`}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
