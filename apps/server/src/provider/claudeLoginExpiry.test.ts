import { describe, expect, it } from "@effect/vitest";

import {
  claudeCredentialsService,
  dueLoginExpiryWarning,
  loginExpiryFromCredentials,
  storedLoginFromCredentials,
} from "./claudeLoginExpiry.ts";

const HOUR = 3_600_000;

describe("Claude login expiry", () => {
  it("names the keychain entry the way Claude Code does", () => {
    expect(claudeCredentialsService(undefined)).toBe("Claude Code-credentials");
    expect(claudeCredentialsService("/tmp/claude-home")).toMatch(
      /^Claude Code-credentials-[0-9a-f]{8}$/,
    );
    expect(claudeCredentialsService("/tmp/claude-home")).not.toBe(
      claudeCredentialsService("/tmp/other-home"),
    );
  });

  it("reads only the refresh token's expiry", () => {
    expect(
      loginExpiryFromCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "a",
            refreshToken: "r",
            refreshTokenExpiresAt: 1_800_000_000_000,
          },
        }),
      ),
    ).toBe(1_800_000_000_000);
    expect(loginExpiryFromCredentials(JSON.stringify({ claudeAiOauth: { expiresAt: 5 } }))).toBe(
      undefined,
    );
    expect(loginExpiryFromCredentials("")).toBe(undefined);
    expect(loginExpiryFromCredentials("not json")).toBe(undefined);
  });

  it("tells a missing login from one without an expiry", () => {
    expect(
      storedLoginFromCredentials(JSON.stringify({ claudeAiOauth: { refreshToken: "r" } })),
    ).toEqual({ expiresAt: undefined });
    expect(storedLoginFromCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBe(undefined);
    expect(storedLoginFromCredentials("")).toBe(undefined);
  });

  it("warns two days ahead, then six hours ahead, and not after it ran out", () => {
    const expiresAt = 1_000 * HOUR;
    expect(dueLoginExpiryWarning(expiresAt, expiresAt - 72 * HOUR)).toBeUndefined();
    expect(dueLoginExpiryWarning(expiresAt, expiresAt - 47 * HOUR)).toBe(48 * HOUR);
    expect(dueLoginExpiryWarning(expiresAt, expiresAt - 5 * HOUR)).toBe(6 * HOUR);
    expect(dueLoginExpiryWarning(expiresAt, expiresAt + HOUR)).toBeUndefined();
  });
});
