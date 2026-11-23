import {
  activeProviderFailure,
  rememberedAccountFailure,
  type ServerProvider,
  type ServerProviderRecentFailure,
} from "@t3tools/contracts";

const DAY = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** A time later today reads as "5:40 PM"; another day adds the weekday. */
export function formatProviderResetTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  return (DAY.format(at) === DAY.format(now) ? TIME : WEEKDAY_TIME).format(at);
}

/** One sentence shared by client notices and agent results. */
export function formatOutOfCredit(
  failure: Pick<ServerProviderRecentFailure, "occurredAt" | "message">,
): string {
  return `Out of credit since ${TIME.format(Date.parse(failure.occurredAt))}: ${failure.message}`;
}

export interface ProviderHealthNotice {
  readonly kind: ServerProviderRecentFailure["kind"];
  readonly outOfCredit?: boolean;
  /** One short line: "At its usage limit until 5:40 PM" or "Signed out since 2:57 PM". */
  readonly title: string;
  /** The provider's own words. */
  readonly message: string;
}

/**
 * What a picker or provider row says about a provider whose latest run failed, while it
 * still applies. Null for a healthy provider.
 */
export function providerHealthNotice(
  provider: Pick<ServerProvider, "recentFailure">,
  now: number,
  model?: string,
): ProviderHealthNotice | null {
  // An account failure stays until a run works, past the time a retry is fair.
  const failure = activeProviderFailure(provider, now, model) ?? rememberedAccountFailure(provider);
  if (!failure) return null;
  if (failure.outOfCredit) {
    return {
      kind: failure.kind,
      outOfCredit: true,
      title: "Out of credit",
      message: formatOutOfCredit(failure),
    };
  }
  if (failure.kind === "usage_limit") {
    return {
      kind: failure.kind,
      title: failure.resetAt
        ? `At its usage limit until ${formatProviderResetTime(failure.resetAt, now)}`
        : "At its usage limit",
      message: failure.message,
    };
  }
  return {
    kind: failure.kind,
    title: `${failure.kind === "authentication_error" ? "Signed out since" : "Last run failed at"} ${formatProviderResetTime(failure.occurredAt, now)}`,
    message: failure.message,
  };
}
