/** Credentials for media requests that cannot set bearer or DPoP headers. */
export interface DeviceHubAccess {
  /** Absolute environment URL ending in `/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Empty for cookie sessions; includes a short-lived ticket for bearer and DPoP sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};

/** Shown once the hub has rejected every refreshed credential in a row. */
export const DEVICE_ACCESS_SIGNED_OUT = "Device access was signed out. Reconnect to try again.";

const ACCESS_RETRY_LIMIT = 5;
const ACCESS_RETRY_BASE_MS = 1_000;

export interface DeviceAccessRetry {
  /**
   * The hub rejected the stream's credential. Returns how long to wait before
   * refreshing it, or `null` once the owner should stop and show
   * `DEVICE_ACCESS_SIGNED_OUT`.
   */
  readonly rejected: () => number | null;
  /**
   * True from a rejection until `reset`. Access that disappears in that window could not be
   * refreshed at all, so the owner shows `DEVICE_ACCESS_SIGNED_OUT` instead of connecting forever.
   */
  readonly awaitingStream: () => boolean;
  /** A stream started, or the user asked to reconnect. */
  readonly reset: () => void;
}

/**
 * Paces stream owners' `onUnauthorized` refreshes. An expired ticket refreshes
 * at once; a credential that stays rejected (a revoked session refreshes to the
 * same cookie) backs off 1 s, 2 s, 4 s and then gives up instead of re-requesting
 * the stream as fast as the hub can answer.
 */
export function createDeviceAccessRetry(): DeviceAccessRetry {
  let rejections = 0;
  return {
    rejected: () => {
      rejections++;
      if (rejections >= ACCESS_RETRY_LIMIT) return null;
      if (rejections === 1) return 0;
      return ACCESS_RETRY_BASE_MS * 2 ** (rejections - 2);
    },
    awaitingStream: () => rejections > 0,
    reset: () => {
      rejections = 0;
    },
  };
}
