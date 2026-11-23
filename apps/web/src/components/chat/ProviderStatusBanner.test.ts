import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(provider, getProviderStatusBannerKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusBanner(
        { ...provider, version: "1.0.1" },
        getProviderStatusBannerKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusBannerKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(message);
    expect(
      getProviderStatusMessage({
        ...broken,
        compatibilityAdvisory: {
          ...broken.compatibilityAdvisory!,
          status: "supported",
          message: null,
        },
      }),
    ).toBe(broken.message);
    expect(getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } })).toBe(
      broken.message,
    );
  });

  it("keeps authentication failures ahead of compatibility warnings even without a probe message", () => {
    const unauthenticated: ServerProvider = {
      ...provider,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    expect(getProviderStatusMessage(unauthenticated)).toBe(
      "Sign in via the CLI to authenticate again.",
    );
    expect(getProviderStatusMessage({ ...unauthenticated, message: "Credentials expired" })).toBe(
      "Credentials expired",
    );
  });
});

describe("usage limit banners", () => {
  const { compatibilityAdvisory: _compatibility, ...healthy } = provider;
  const limited: ServerProvider = {
    ...healthy,
    recentFailure: {
      kind: "usage_limit",
      message: "You've hit your limit.",
      occurredAt: "2026-11-03T20:00:00.000Z",
      resetAt: "2999-01-01T00:00:00.000Z",
    },
  };

  it("warns about a limit another chat's run hit, unless this chat shows its own failure", () => {
    expect(getProviderStatusBannerKey(limited, { showRecentFailure: true })).not.toBeNull();
    expect(getProviderStatusBannerKey(limited, { showRecentFailure: false })).toBeNull();
    expect(getProviderStatusBannerKey(limited)).toBeNull();
  });

  it("stays quiet for provider errors and limits whose reset has passed", () => {
    expect(
      getProviderStatusBannerKey(
        { ...limited, recentFailure: { ...limited.recentFailure!, kind: "provider_error" } },
        { showRecentFailure: true },
      ),
    ).toBeNull();
    expect(
      getProviderStatusBannerKey(
        {
          ...limited,
          recentFailure: { ...limited.recentFailure!, resetAt: "2001-01-01T00:00:00.000Z" },
        },
        { showRecentFailure: true },
      ),
    ).toBeNull();
  });

  it("only warns chats using a model covered by the limit", () => {
    const scoped = {
      ...limited,
      recentFailure: { ...limited.recentFailure!, modelIds: ["fable"] },
    };
    const options = { showRecentFailure: true, now: Date.parse("2026-11-17T16:00:00.000Z") };
    expect(getProviderStatusBannerKey(scoped, { ...options, model: "opus" })).toBeNull();
    expect(getProviderStatusBannerKey(scoped, { ...options, model: "fable" })).not.toBeNull();
  });

  it("comes back for a newer limit after being dismissed", () => {
    const dismissed = getProviderStatusBannerKey(limited, { showRecentFailure: true });
    const newer: ServerProvider = {
      ...limited,
      recentFailure: { ...limited.recentFailure!, occurredAt: "2026-11-03T21:00:00.000Z" },
    };
    expect(shouldShowProviderStatusBanner(limited, dismissed, { showRecentFailure: true })).toBe(
      false,
    );
    expect(shouldShowProviderStatusBanner(newer, dismissed, { showRecentFailure: true })).toBe(
      true,
    );
  });
});
