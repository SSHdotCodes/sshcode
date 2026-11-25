import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  providerStatusKey,
} from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("a provider whose last run ended on its account", () => {
  const signedOut: ServerProvider = {
    ...provider,
    recentFailure: {
      kind: "authentication_error",
      message: "Signed out. Sign in again.",
      occurredAt: "2026-08-22T20:00:00.000Z",
      resetAt: "2026-08-22T21:00:00.000Z",
    },
  };
  const later = Date.parse("2026-08-23T12:00:00.000Z");

  it("says so instead of Authenticated, long after another try became fair", () => {
    const summary = getProviderSummary(signedOut, later);
    expect(summary.headline).toMatch(/^Signed out since \S/);
    expect(summary.detail).toBe("Signed out. Sign in again.");
    expect(providerStatusKey(signedOut)).toBe("warning");
  });

  it("leaves a usage limit and a healthy provider reading as they did", () => {
    const limited: ServerProvider = {
      ...provider,
      recentFailure: {
        kind: "usage_limit",
        message: "You've hit your limit.",
        occurredAt: "2026-08-22T20:00:00.000Z",
        resetAt: "2999-01-01T00:00:00.000Z",
      },
    };
    expect(getProviderSummary(limited, later).headline).toBe("Authenticated · ChatGPT");
    expect(providerStatusKey(limited)).toBe("ready");
    expect(providerStatusKey(provider)).toBe("ready");
    expect(providerStatusKey({ ...signedOut, status: "error" })).toBe("error");
    expect(providerStatusKey(undefined)).toBe("warning");
  });
});

describe("getProviderSummary", () => {
  it("shows a saved provider as refreshing while keeping its ready status", () => {
    const saved = { ...provider, refreshing: true };
    expect(getProviderSummary(saved).headline).toBe("Refreshing provider status");
    expect(providerStatusKey(saved)).toBe("ready");
    expect(providerStatusKey({ ...saved, status: "warning", installed: false })).toBe("neutral");
    expect(getProviderSummary({ ...saved, auth: { status: "unauthenticated" } }).headline).toBe(
      "Not authenticated",
    );
  });

  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});

describe("provider status copy", () => {
  it("surfaces an ACP-advertised authentication method", () => {
    const provider = {
      enabled: true,
      installed: true,
      status: "error",
      auth: { status: "unauthenticated", type: "agent", label: "Company login" },
      message: "Complete this authentication method on the server.",
    } as ServerProvider;

    expect(getProviderSummary(provider)).toEqual({
      headline: "Not authenticated · Company login",
      detail: "Complete this authentication method on the server.",
    });
  });
});

describe("Antigravity with unchecked sign-in", () => {
  const unchecked: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    auth: { status: "unknown" },
    message: "Antigravity is installed. Google account access is not checked yet.",
  };

  it("presents an unchecked Google sign-in neutrally without claiming authentication is required", () => {
    for (const auth of [unchecked.auth, { status: "unknown", type: "oauth-personal" }] as const) {
      const candidate = { ...unchecked, auth };
      expect.soft(getProviderSummary(candidate)).toEqual({
        headline: "Installed · Sign-in not checked",
        detail: unchecked.message,
      });
      expect(providerStatusKey(candidate)).toBe("neutral");
    }
  });

  it("preserves actionable warnings, failures and disabled states outside unchecked Google sign-in", () => {
    const cases = [
      {
        name: "confirmed sign-out",
        change: { auth: { status: "unauthenticated" } },
        headline: "Not authenticated",
        status: "warning",
      },
      {
        name: "warning despite known authentication",
        change: { auth: { status: "authenticated" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "probe failure",
        change: { status: "error" },
        headline: "Unavailable",
        status: "error",
      },
      {
        name: "missing CLI",
        change: { installed: false },
        headline: "Not found",
        status: "warning",
      },
      {
        name: "API key authentication",
        change: { auth: { status: "unknown", type: "gemini-api-key" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "Agent Platform authentication",
        change: { auth: { status: "unknown", type: "agent-platform" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "another provider",
        change: { driver: provider.driver },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "disabled provider",
        change: { enabled: false },
        headline: "Disabled",
        status: "disabled",
      },
    ] as const;
    for (const { name, change, headline, status } of cases) {
      const candidate = { ...unchecked, ...change };
      expect.soft(getProviderSummary(candidate).headline, name).toBe(headline);
      expect.soft(providerStatusKey(candidate), name).toBe(status);
    }
  });
});
