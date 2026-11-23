import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { withoutLoginIdentity } from "../ClaudeProvider.ts";
import { CLAUDE_TOKEN_ENV, limitsOnSavedToken, makeClaudeLoginFallback } from "./ClaudeLogin.ts";

describe("a Claude instance that always uses its saved token", () => {
  // The driver gives such an instance no stored login to prefer.
  it.effect("starts every process on the token and never returns to the login", () =>
    Effect.gen(function* () {
      const login = yield* makeClaudeLoginFallback("second-account", Effect.succeed(undefined));
      expect(yield* login.usingToken).toBe(true);
      expect(yield* login.environment({ PATH: "/bin" })).toEqual({
        PATH: "/bin",
        [CLAUDE_TOKEN_ENV]: "second-account",
      });
      // A fresh login on this computer belongs to the other account.
      expect(yield* login.loginRenewed).toBe(false);
      expect(yield* login.useToken).toBe(false);
    }),
  );

  it("names no account: the stored profile is the other subscription's", () => {
    const probe = {
      email: "first@example.com",
      workspaceId: "org-first",
      subscriptionType: "max",
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      apiKeySource: undefined,
    } as unknown as NonNullable<Parameters<typeof withoutLoginIdentity>[0]>;
    const own = withoutLoginIdentity(probe);
    expect(own?.email).toBeUndefined();
    expect(own?.workspaceId).toBeUndefined();
    expect(own?.subscriptionType).toBe("max");
    expect(withoutLoginIdentity(undefined)).toBeUndefined();
  });
});

describe("an instance running on its saved token after its login stopped working", () => {
  it("says why the login's limits cannot be read, and how to get them back", () => {
    const command = "CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login";
    const failed = {
      checkedAt: "2026-11-22T19:59:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(limitsOnSavedToken(failed, command)).toEqual({
      ...failed,
      unavailable: {
        reason: "probeFailed",
        message: `Its login is signed out, so it runs on its saved token. Run \`${command}\` to read limits again.`,
      },
    });
    // A reading that worked, or an account that has no limits, is left alone.
    const read = { checkedAt: failed.checkedAt, windows: [] };
    expect(limitsOnSavedToken(read, command)).toBe(read);
    expect(limitsOnSavedToken(undefined, command)).toBeUndefined();
  });
});
