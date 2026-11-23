import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  mapManagedRelayError,
  type ConnectionAttemptError,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAuthInvalidError,
  RelayEnvironmentEndpointUnavailableError,
  type RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  connectionDetailsPresentation,
  connectionDoctorPresentation,
  diagnoseConnectionRoute,
} from "./connection-doctor";

const environmentId = EnvironmentId.make("mac");
function directRoute(connectionId: string, hostname: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({ environmentId, connectionId, label: "Mac" }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId,
        connectionId,
        label: "Mac",
        httpBaseUrl: `http://${hostname}:3773`,
        wsBaseUrl: `ws://${hostname}:3773`,
      }),
    ),
  };
}
const lan = directRoute("lan", "192.168.1.20");
const tailscale = directRoute("tailnet", "mac.tail123.ts.net");
const relay: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId, label: "Mac" }),
  profile: Option.none(),
};
const entry: ConnectionCatalogEntry = {
  ...lan,
  alternateRoutes: [tailscale, relay],
  enabled: true,
};
const unavailable = (reason: ConnectionTransientError["reason"]) =>
  new ConnectionTransientError({ reason, detail: "Request failed." });
const diagnose = (route: ConnectionRoute, failure: ConnectionAttemptError | null) =>
  diagnoseConnectionRoute({ route, failure, trying: false, relayStatus: null });

const offline: RelayEnvironmentStatusResponse = {
  environmentId,
  endpoint: {
    httpBaseUrl: "https://mac.example.test",
    wsBaseUrl: "wss://mac.example.test",
    providerKind: "cloudflare_tunnel",
  },
  status: "offline",
  checkedAt: "2026-10-22T02:00:00Z",
  error: "Endpoint request failed with HTTP 502.",
  traceId: "trace-offline",
};

describe("connection doctor", () => {
  it.each(["network", "timeout", "transport", "endpoint-unavailable"] as const)(
    "explains unreachable LAN and Tailscale routes (%s)",
    (reason) => {
      expect(diagnose(lan, unavailable(reason))).toMatchObject({
        label: "LAN",
        reason: "lan-unreachable",
        summary: "Your Mac didn’t answer on the LAN route",
      });
      expect(diagnose(tailscale, unavailable(reason))).toMatchObject({
        label: "Tailscale",
        reason: "tailscale-unreachable",
        summary: "Your Mac didn’t answer on the Tailscale route",
        nextStep: expect.stringContaining("Tailscale may be off on either device"),
      });
    },
  );

  it("does not blame Wi-Fi or Tailscale for a rejected credential or server failure", () => {
    for (const route of [lan, tailscale]) {
      expect(
        diagnose(route, new ConnectionBlockedError({ reason: "authentication", detail: "Denied" })),
      ).toMatchObject({ reason: "authentication", detail: "Denied" });
      expect(diagnose(route, unavailable("remote-unavailable")).reason).toBe("unavailable");
    }
  });

  it("explains a VPN failure", () => {
    expect(diagnose(directRoute("vpn", "100.64.12.1"), unavailable("network"))).toMatchObject({
      label: "VPN",
      reason: "vpn-unreachable",
    });
  });

  it("identifies sign-in failures even on a direct route learned from T3 Connect", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Sign in to T3 Connect.",
      source: "cloud-session",
    });
    expect(diagnose(relay, failure).reason).toBe("sign-in");
    expect(diagnose(tailscale, failure).reason).toBe("sign-in");
  });

  it.each(["invalid_bearer", "invalid_dpop"] as const)(
    "keeps relay authentication causes distinct (%s)",
    (reason) => {
      const relayError = new RelayAuthInvalidError({
        code: "auth_invalid",
        reason,
        traceId: "trace-auth",
      });
      const failure = mapManagedRelayError(
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "connect relay environment",
          cause: relayError,
          relayError,
        }),
      );
      expect(diagnose(relay, failure)).toMatchObject({
        reason: reason === "invalid_bearer" ? "sign-in" : "authentication",
        detail: failure.detail,
        traceId: "trace-auth",
      });
    },
  );

  it("distinguishes an unreachable relay from a relay that returned an error", () => {
    const transport = mapManagedRelayError(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new Error("Network failed"),
      }),
    );
    expect(diagnose(relay, transport).reason).toBe("relay-unreachable");
    const timeout = mapManagedRelayError(
      new ManagedRelay.ManagedRelayRequestTimeoutError({
        activity: "Relay environment connection",
        timeoutMs: 20_000,
        traceId: "trace-local-timeout",
      }),
    );
    expect(diagnose(relay, timeout)).toMatchObject({
      reason: "relay-unreachable",
      traceId: "trace-local-timeout",
    });
    const relayError = new RelayEnvironmentEndpointUnavailableError({
      code: "environment_endpoint_unavailable",
      reason: "endpoint_request_failed",
      traceId: "trace-endpoint",
    });
    const failure = mapManagedRelayError(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: relayError,
        relayError,
      }),
    );
    expect(diagnose(relay, failure)).toMatchObject({
      reason: "unavailable",
      detail: "Relay could not reach the environment endpoint (endpoint_request_failed).",
      traceId: "trace-endpoint",
    });
    const http = mapManagedRelayError(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "connect relay environment",
        status: 504,
        cause: new Error("Gateway timeout"),
      }),
    );
    expect(diagnose(relay, http)).toMatchObject({
      reason: "unavailable",
      detail: expect.stringContaining("HTTP 504"),
    });
  });

  it("does not hide a current relay network failure behind an older offline report", () => {
    const failure = new ConnectionTransientError({
      reason: "network",
      source: "relay",
      detail: "No response.",
    });
    expect(
      diagnoseConnectionRoute({ route: relay, failure, trying: false, relayStatus: offline })
        .reason,
    ).toBe("relay-unreachable");
    expect(
      diagnose(
        tailscale,
        new ConnectionTransientError({
          reason: "network",
          source: "cloud-session",
          detail: "Could not obtain session token.",
        }),
      ).reason,
    ).toBe("relay-unreachable");
  });

  it("uses explicit relay offline reports and preserves the relay's actual error", () => {
    expect(
      diagnoseConnectionRoute({
        route: relay,
        failure: unavailable("timeout"),
        trying: false,
        relayStatus: offline,
      }),
    ).toMatchObject({
      reason: "mac-offline",
      detail: expect.stringContaining(offline.error!),
      traceId: offline.traceId,
    });
    expect(
      diagnoseConnectionRoute({
        route: relay,
        failure: null,
        trying: false,
        relayStatus: { ...offline, offlineReason: "tunnel_released" },
      }).detail,
    ).toContain("tunnel was removed");
    expect(
      diagnoseConnectionRoute({
        route: lan,
        failure: unavailable("network"),
        trying: false,
        relayStatus: offline,
      }).reason,
    ).toBe("lan-unreachable");
  });

  it("keeps every route's result when a transient direct failure masks relay authentication", () => {
    const lanError = unavailable("timeout");
    const relayError = new ConnectionBlockedError({
      reason: "authentication",
      source: "cloud-session",
      detail: "Signed out.",
    });
    const state = {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "backoff" as const,
      lastFailure: lanError,
      routeFailures: new Map<string, ConnectionAttemptError>([
        ["lan", lanError],
        ["relay", relayError],
      ]),
    };
    const doctor = connectionDoctorPresentation({
      entry,
      state,
      network: "online",
      relayStatus: null,
    });
    expect(doctor?.routes.map((route) => route.reason)).toEqual([
      "lan-unreachable",
      "pending",
      "sign-in",
    ]);
    expect(doctor?.routes.map((route) => route.label)).toEqual(["LAN", "Tailscale", "T3 Connect"]);
  });

  it("shows no internet and does not claim untried routes failed", () => {
    const doctor = connectionDoctorPresentation({
      entry,
      state: AVAILABLE_CONNECTION_STATE,
      network: "offline",
      relayStatus: null,
    });
    expect(doctor?.summary).toBe("No internet connection on this iPhone");
    expect(doctor?.routes.every((route) => route.reason === "pending")).toBe(true);
  });

  it("shows the route being tried and hides the doctor for connected or disabled environments", () => {
    const state = {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connecting" as const,
      activeRouteId: "relay",
    };
    expect(
      connectionDoctorPresentation({ entry, state, network: "online", relayStatus: null })
        ?.routes[2]?.reason,
    ).toBe("trying");
    expect(
      connectionDoctorPresentation({
        entry,
        state: { ...state, phase: "connected" },
        network: "online",
        relayStatus: null,
      }),
    ).toBeNull();
    expect(
      connectionDoctorPresentation({
        entry: { ...entry, enabled: false },
        state,
        network: "online",
        relayStatus: null,
      }),
    ).toBeNull();
  });
});

describe("connection details", () => {
  it("shows the supervisor stage, route and scheduled retry", () => {
    expect(
      connectionDetailsPresentation({
        entry,
        state: {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connecting",
          stage: "synchronizing",
          activeRouteId: "relay",
        },
      }),
    ).toEqual({ stage: "Loading initial configuration", activeRoute: "T3 Connect", retryAt: null });
    expect(
      connectionDetailsPresentation({
        entry,
        state: {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "backoff",
          retryAt: 1234,
        },
      }),
    ).toEqual({ stage: "Waiting to retry", activeRoute: null, retryAt: 1234 });
    expect(
      connectionDetailsPresentation({
        entry,
        state: {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          activeRouteId: "tailnet",
        },
      }),
    ).toEqual({ stage: "Connected", activeRoute: "Tailscale", retryAt: null });
  });
});
