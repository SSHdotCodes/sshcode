// @effect-diagnostics globalDate:off -- Local picker inputs use the device calendar and an injectable clock.
import type { ServerConfig } from "@t3tools/contracts";

/** Local picker value; the server stores the selected instant in UTC. */
export function scheduledMessageLocalDateTime(instant: string | number): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Reject invalid dates, past times and local times skipped by daylight saving. */
export function scheduledMessageInstant(value: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now) return null;
  if (scheduledMessageLocalDateTime(date.getTime()) !== value) return null;
  return date.toISOString();
}

/** Older environments must opt in before a client offers a one-shot write. */
export function scheduledMessageUnavailableReason(
  config: Pick<ServerConfig, "scheduledMessages"> | null | undefined,
): string | null {
  return config?.scheduledMessages === true
    ? null
    : "Update this environment to schedule messages.";
}
