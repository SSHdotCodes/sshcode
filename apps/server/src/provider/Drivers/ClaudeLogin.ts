import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import type { StoredClaudeLogin } from "../claudeLoginExpiry.ts";

/**
 * Which credential a Claude instance's new processes use. The regular
 * `claude auth login` comes first: only it can read usage and load claude.ai
 * connectors. A long-lived token saved as CLAUDE_CODE_OAUTH_TOKEN (from
 * `claude setup-token`) can only send messages, so it waits as the fallback
 * for when the login stops working (SignInRecoveryWorker switches). Claude
 * Code prefers the token whenever it is set, so the token stays out of every
 * process until then.
 *
 * Signing in again writes a fresh login with a new expiry; that is how the
 * instance notices it can go back, without spending any usage on a check.
 * Where no login is stored at all (a remote machine that gets only the token,
 * so it never refreshes the Mac's login out from under it), the token is used
 * from the first process on.
 *
 * Processes keep the credential they started with; switching affects the
 * next ones. The choice lives with the instance, so a restart or a settings
 * change starts on the login again.
 */
export interface ClaudeLoginFallback {
  readonly usingToken: Effect.Effect<boolean>;
  /** The environment new Claude processes start with. */
  readonly environment: (base: NodeJS.ProcessEnv) => Effect.Effect<NodeJS.ProcessEnv>;
  /** Switches new processes to the token. False when it was already in use. */
  readonly useToken: Effect.Effect<boolean>;
  readonly useLogin: Effect.Effect<void>;
  /** Whether a new login was stored since the switch to the token. */
  readonly loginRenewed: Effect.Effect<boolean>;
}

export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** The environment without the token, and the token itself when one is set. */
export function splitClaudeToken(environment: NodeJS.ProcessEnv): {
  readonly environment: NodeJS.ProcessEnv;
  readonly token: string | undefined;
} {
  const { [CLAUDE_TOKEN_ENV]: token, ...rest } = environment;
  // Pasted tokens can carry a terminal's line breaks.
  const cleaned = token?.replace(/\s+/g, "");
  return { environment: rest, token: cleaned === "" ? undefined : cleaned };
}

/** `readLogin` reads the stored login (claudeLoginExpiry.ts), unset when there is none. */
export const makeClaudeLoginFallback = (
  token: string,
  readLogin: Effect.Effect<StoredClaudeLogin | undefined>,
) =>
  Effect.gen(function* () {
    type State =
      | { readonly usingToken: false }
      | { readonly usingToken: true; readonly loginAtSwitch: number | undefined };
    // Decided at the first use, so creating the instance never waits on the keychain.
    const state = yield* Ref.make<State | undefined>(undefined);
    const current = Effect.gen(function* () {
      const known = yield* Ref.get(state);
      if (known !== undefined) return known;
      const initial: State =
        (yield* readLogin) === undefined
          ? { usingToken: true, loginAtSwitch: undefined }
          : { usingToken: false };
      return yield* Ref.modify(state, (now) => [now ?? initial, now ?? initial] as const);
    });
    return {
      usingToken: current.pipe(Effect.map((now) => now.usingToken)),
      environment: (base) =>
        current.pipe(
          Effect.map((now) => (now.usingToken ? { ...base, [CLAUDE_TOKEN_ENV]: token } : base)),
        ),
      useToken: Effect.gen(function* () {
        if ((yield* current).usingToken) return false;
        const loginAtSwitch = (yield* readLogin)?.expiresAt;
        return yield* Ref.modify(state, (now) =>
          now?.usingToken
            ? ([false, now] as const)
            : ([true, { usingToken: true, loginAtSwitch }] as const),
        );
      }),
      useLogin: Ref.set(state, { usingToken: false }),
      loginRenewed: Effect.gen(function* () {
        const now = yield* current;
        if (!now.usingToken) return false;
        const expiry = (yield* readLogin)?.expiresAt;
        return expiry !== undefined && expiry !== now.loginAtSwitch;
      }),
    } satisfies ClaudeLoginFallback;
  });

/**
 * The limits an instance publishes while its new processes run on the saved token: the
 * status check still reads them with the login, which no longer works, and the token
 * cannot read them at all.
 */
export function limitsOnSavedToken(
  limits: ServerProviderUsageLimits | undefined,
  signInCommand: string,
): ServerProviderUsageLimits | undefined {
  if (limits?.unavailable?.reason !== "probeFailed") return limits;
  return {
    ...limits,
    unavailable: {
      reason: "probeFailed",
      message: `Its login is signed out, so it runs on its saved token. Run \`${signInCommand}\` to read limits again.`,
    },
  };
}
