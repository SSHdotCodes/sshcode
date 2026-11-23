import {
  type ConnectionAttemptError,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  type NetworkStatus,
  type SupervisorConnectionState,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  connectionRoutes,
} from "@t3tools/client-runtime/connection";
import { relayOfflineReasonMessage } from "@t3tools/client-runtime/relay";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";

export interface ConnectionRouteDiagnosis {
  readonly routeId: string;
  readonly label: string;
  readonly reason:
    | "pending"
    | "trying"
    | "lan-unreachable"
    | "tailscale-unreachable"
    | "vpn-unreachable"
    | "sign-in"
    | "relay-unreachable"
    | "mac-offline"
    | "authentication"
    | "unavailable";
  readonly summary: string;
  readonly nextStep: string | null;
  readonly detail: string | null;
  readonly traceId: string | null;
}

export function diagnoseConnectionRoute(input: {
  readonly route: ConnectionRoute;
  readonly failure: ConnectionAttemptError | null;
  readonly trying: boolean;
  readonly relayStatus: RelayEnvironmentStatusResponse | null;
}): ConnectionRouteDiagnosis {
  const { route, failure, relayStatus } = input;
  const base = {
    routeId: connectionRouteId(route.target),
    label: connectionRouteLabel(route),
    detail: failure?.detail ?? null,
    traceId: failure?.traceId ?? null,
  };
  const kind = connectionRouteKind(route);
  if (
    failure?.reason === "authentication" &&
    (failure.source === "cloud-session" ||
      (failure.relayCode === "auth_invalid" &&
        (failure.relayReason === "missing_bearer" || failure.relayReason === "invalid_bearer")))
  ) {
    return {
      ...base,
      reason: "sign-in",
      summary: "T3 Connect needs you to sign in",
      nextStep: "Sign in to T3 Connect again in Settings.",
    };
  }
  if (
    (kind === "relay" && failure?.source === "relay" && failure?.relayCode === undefined) ||
    failure?.source === "cloud-session"
  ) {
    return {
      ...base,
      reason: "relay-unreachable",
      summary: "This iPhone can’t reach T3 Connect",
      nextStep: "Check your internet connection and allow cellular data for SSHCode, then retry.",
    };
  }
  if (
    kind === "relay" &&
    relayStatus?.status === "offline" &&
    failure?._tag !== "ConnectionBlockedError"
  ) {
    return {
      ...base,
      reason: "mac-offline",
      summary: "The relay last reported your Mac offline",
      nextStep: "Open SSHCode on your Mac and check T3 Connect in Settings.",
      detail:
        [
          ...new Set(
            [relayOfflineReasonMessage(relayStatus), relayStatus.error, base.detail].filter(
              Boolean,
            ),
          ),
        ].join(" ") || null,
      traceId: base.traceId ?? relayStatus.traceId ?? null,
    };
  }
  if (failure === null) {
    return {
      ...base,
      reason: input.trying ? "trying" : "pending",
      summary: input.trying ? "Trying this route…" : "Not tried yet",
      nextStep: null,
    };
  }
  if (failure._tag === "ConnectionBlockedError") {
    return {
      ...base,
      reason: failure.reason === "authentication" ? "authentication" : "unavailable",
      summary:
        failure.reason === "authentication"
          ? "This iPhone could not be authorized"
          : "This route could not connect",
      nextStep:
        failure.reason === "authentication"
          ? "Check the error below, then reconnect."
          : failure.reason === "unsupported"
            ? "Update SSHCode on your Mac and this iPhone."
            : "Check this route in Settings on your Mac, then reconnect.",
    };
  }
  // A response from the Mac or relay is not evidence of a missing Wi-Fi or VPN.
  const unreachable = ["network", "timeout", "transport", "endpoint-unavailable"].includes(
    failure.reason,
  );
  if (failure.source === undefined && unreachable) {
    if (kind === "lan") {
      return {
        ...base,
        reason: "lan-unreachable",
        summary: "Your Mac didn’t answer on the LAN route",
        nextStep:
          "Your Mac may be asleep, on another Wi-Fi network, or its port may be blocked. Check SSHCode on your Mac, or try another route.",
      };
    }
    if (kind === "tailnet") {
      return {
        ...base,
        reason: "tailscale-unreachable",
        summary: "Your Mac didn’t answer on the Tailscale route",
        nextStep:
          "Your Mac may be asleep, Tailscale may be off on either device, or its port may be blocked. Check both devices, or try T3 Connect.",
      };
    }
    if (kind === "vpn") {
      return {
        ...base,
        reason: "vpn-unreachable",
        summary: "Your Mac’s VPN address is unreachable",
        nextStep:
          "Your Mac may be asleep, either device may be off the VPN, or its port may be blocked. Check both devices, or try another route.",
      };
    }
  }
  return {
    ...base,
    reason: "unavailable",
    summary: kind === "relay" ? "T3 Connect could not connect" : "This route could not connect",
    nextStep:
      kind === "relay"
        ? "Check the error below. Open SSHCode on your Mac and check T3 Connect in Settings."
        : "Make sure SSHCode is running on your Mac, then reconnect.",
  };
}

export function connectionDoctorPresentation(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly state: SupervisorConnectionState;
  readonly network: NetworkStatus;
  readonly relayStatus: RelayEnvironmentStatusResponse | null;
}) {
  if (!input.entry.enabled || input.state.phase === "connected") return null;
  const offline = input.network === "offline";
  return {
    summary: offline ? "No internet connection on this iPhone" : "Can’t reach your Mac",
    nextStep: offline
      ? "Turn on cellular data or connect to Wi-Fi, then retry."
      : "Routes are tried automatically. Check the last result for each route below.",
    routes: connectionRoutes(input.entry).map((route) =>
      diagnoseConnectionRoute({
        route,
        failure: input.state.routeFailures.get(connectionRouteId(route.target)) ?? null,
        trying: !offline && input.state.activeRouteId === connectionRouteId(route.target),
        relayStatus: input.relayStatus,
      }),
    ),
  };
}

export function connectionDetailsPresentation(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly state: SupervisorConnectionState;
}) {
  const { state } = input;
  const stages = {
    preparing: "Preparing connection",
    opening: "Opening connection",
    synchronizing: "Loading initial configuration",
  };
  const phases = {
    available: "Disconnected",
    connected: "Connected",
    connecting: "Connecting",
    backoff: "Waiting to retry",
    offline: "Device reports offline",
    blocked: "Connection needs attention",
  };
  const active = connectionRoutes(input.entry).find(
    (route) => connectionRouteId(route.target) === state.activeRouteId,
  );
  return {
    stage: state.stage === null ? phases[state.phase] : stages[state.stage],
    activeRoute: active === undefined ? null : connectionRouteLabel(active),
    retryAt: state.retryAt,
  };
}
