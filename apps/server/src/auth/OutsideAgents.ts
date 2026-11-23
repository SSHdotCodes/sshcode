import {
  type AuthMcpClientAccess,
  type OutsideAgentsCommand,
  OutsideAgentsError,
  type OutsideAgentSignIn,
  type OutsideAgentsState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import * as McpOAuth from "./McpOAuth.ts";
import { timingSafeEqualBase64Url, timingSafeEqualText } from "./utils.ts";

/**
 * Sign-ins from agents SSHCode did not launch, waiting for the owner to answer
 * in the app by typing the code shown on the agent's sign-in page.
 *
 * The page anyone can reach only registers a request and polls for its own
 * answer with a secret it alone holds; approving happens over an owner's
 * authenticated app connection. Everything here is off until the
 * `outsideAgents` setting is on, and turning it off forgets every request.
 */

/** Long enough to walk to the phone; a stale prompt is worse than a retry. */
const SIGN_IN_TTL_MS = 10 * 60_000;
/** A public page can create requests, so their number is bounded. */
const MAX_WAITING = 5;
const isOutsideAgentsError = Schema.is(OutsideAgentsError);
/** An answered request stays only until its page collects the answer. */
const ANSWER_TTL_MS = 60_000;
/**
 * New sign-ins are taken only for a while after the owner asks for them
 * (turning outside agents on, or Connect an agent), so strangers who find
 * the address cannot fill the owner's screen with prompts the rest of the time.
 */
const ACCEPT_WINDOW_MS = 10 * 60_000;

interface Waiting {
  readonly signIn: OutsideAgentSignIn;
  readonly key: string;
  readonly pollSecret: string;
  readonly authorization: McpOAuth.AuthorizationRequest;
  /** Where the page sends the browser once the owner answered. */
  readonly answer: string | undefined;
  /** An answer is being made; a second one is refused. */
  readonly claimed: boolean;
}

const requestKey = (authorization: McpOAuth.AuthorizationRequest) =>
  JSON.stringify([
    authorization.client.clientId,
    authorization.redirectUri,
    authorization.codeChallenge,
  ]);

export class OutsideAgents extends Context.Service<
  OutsideAgents,
  {
    readonly enabled: Effect.Effect<boolean>;
    /** Registers a sign-in for the owner to answer, replacing one with the same parameters. */
    readonly request: (
      authorization: McpOAuth.AuthorizationRequest,
    ) => Effect.Effect<
      { readonly id: string; readonly pollSecret: string; readonly code: string },
      OutsideAgentsError
    >;
    /**
     * The page's answer: `undefined` while the owner has not answered, then
     * the redirect, handed out once.
     */
    readonly status: (input: {
      readonly id: string;
      readonly pollSecret: string;
      readonly authorization: McpOAuth.AuthorizationRequest;
    }) => Effect.Effect<string | undefined, OutsideAgentsError>;
    readonly state: Effect.Effect<OutsideAgentsState>;
    readonly changes: Stream.Stream<OutsideAgentsState>;
    readonly command: (
      command: OutsideAgentsCommand,
    ) => Effect.Effect<OutsideAgentsState, OutsideAgentsError>;
  }
>()("t3/auth/OutsideAgents") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const oauth = yield* McpOAuth.McpOAuth;
  const crypto = yield* Crypto.Crypto;
  const waiting = yield* Ref.make<ReadonlyMap<string, Waiting>>(new Map());
  /** New sign-ins are taken until this time; closed while 0 or in the past. */
  const acceptingUntil = yield* Ref.make(0);
  /** Bumped when outside agents turn off, so an approval in flight cannot land after. */
  const generation = yield* Ref.make(0);
  const changed = yield* PubSub.sliding<void>(1);

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.outsideAgents),
    Effect.orElseSucceed(() => false),
  );

  const randomId = (bytes: number) =>
    crypto.randomBytes(bytes).pipe(
      Effect.orDie,
      Effect.map((value) => Buffer.from(value).toString("base64url")),
    );

  const randomCode = Effect.gen(function* () {
    while (true) {
      const bytes = yield* crypto.randomBytes(2).pipe(Effect.orDie);
      const value = bytes[0]! * 256 + bytes[1]!;
      // Six equally sized ranges; reject the tail to avoid modulo bias.
      if (value < 60_000) return String(value % 10_000).padStart(4, "0");
    }
  });

  /** Drops expired requests and answers nobody collected. */
  const live = (now: number) =>
    Ref.updateAndGet(
      waiting,
      (current) =>
        new Map(
          Array.from(current).filter(([, entry]) =>
            entry.answer === undefined
              ? entry.signIn.expiresAt > now
              : entry.signIn.expiresAt + ANSWER_TTL_MS > now,
          ),
        ),
    );

  const state = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* live(now);
    const on = yield* enabled;
    const until = yield* Ref.get(acceptingUntil);
    return {
      enabled: on,
      acceptingUntil: on && until > now ? until : null,
      // Off, nothing can be approved, so nothing is shown.
      pending: Array.from(on ? current.values() : [])
        .filter((entry) => entry.answer === undefined)
        .map((entry) => entry.signIn)
        .toSorted((a, b) => a.requestedAt - b.requestedAt),
    } satisfies OutsideAgentsState;
  });

  const publish = PubSub.publish(changed, undefined);
  const off = new OutsideAgentsError({
    message:
      "Outside agents are off in SSHCode. Turn them on in Settings → Connections → Outside agents, then sign in again.",
  });

  const openSignIns = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.set(acceptingUntil, now + ACCEPT_WINDOW_MS);
  });

  const request: OutsideAgents["Service"]["request"] = (authorization) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return yield* off;
      const now = yield* Clock.currentTimeMillis;
      if ((yield* Ref.get(acceptingUntil)) <= now) {
        return yield* new OutsideAgentsError({
          message:
            "SSHCode isn't taking new agents right now. In SSHCode, open Settings → Connections → Outside agents, choose Connect an agent, then sign in again.",
        });
      }
      yield* live(now);
      const key = requestKey(authorization);
      const id = yield* randomId(12);
      const pollSecret = yield* randomId(32);
      let code: string;
      while (true) {
        code = yield* randomCode;
        const added = yield* Ref.modify(waiting, (current) => {
          // Include the request being replaced: its new code must differ too.
          if (
            Array.from(current.values()).some(
              (entry) => entry.answer === undefined && entry.signIn.code === code,
            )
          )
            return ["collision", current] as const;
          // The request's parameters are not secret: a page that repeats them
          // (a reload, or anyone holding the link) replaces the request with new
          // credentials instead of learning the old ones.
          const next = new Map(
            Array.from(current).filter(
              ([, entry]) => entry.key !== key || entry.answer !== undefined,
            ),
          );
          if (Array.from(next.values()).filter((e) => e.answer === undefined).length >= MAX_WAITING)
            return ["full", current] as const;
          next.set(id, {
            key,
            pollSecret,
            authorization,
            answer: undefined,
            claimed: false,
            signIn: {
              id,
              code,
              clientName: authorization.client.name,
              redirectHost: new URL(authorization.redirectUri).host,
              requestedAt: now,
              expiresAt: now + SIGN_IN_TTL_MS,
            },
          });
          return ["added", next] as const;
        });
        if (added === "collision") continue;
        if (added === "full") {
          return yield* new OutsideAgentsError({
            message: "Too many sign-ins are waiting. Answer them in SSHCode, then try again.",
          });
        }
        break;
      }
      yield* Effect.logInfo("An outside agent is waiting for approval.", {
        client: authorization.client.name,
        redirectHost: new URL(authorization.redirectUri).host,
      });
      yield* publish;
      return { id, pollSecret, code };
    });

  const status: OutsideAgents["Service"]["status"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = (yield* live(now)).get(input.id);
      if (
        entry === undefined ||
        entry.key !== requestKey(input.authorization) ||
        !timingSafeEqualBase64Url(input.pollSecret, entry.pollSecret)
      ) {
        return yield* new OutsideAgentsError({
          message: "This sign-in expired or was cancelled. Start it again from the agent.",
        });
      }
      if (entry.answer === undefined) return undefined;
      yield* Ref.update(waiting, (current) => {
        const next = new Map(current);
        next.delete(input.id);
        return next;
      });
      return entry.answer;
    });

  const unavailable = new OutsideAgentsError({
    message: "That sign-in expired or was already answered.",
  });

  const answer = (
    input: Extract<OutsideAgentsCommand, { readonly _tag: "approve" | "deny" }>,
    decide: (entry: Waiting) => Effect.Effect<string>,
  ) =>
    Effect.gen(function* () {
      const { id } = input;
      if (!(yield* enabled)) return yield* off;
      const now = yield* Clock.currentTimeMillis;
      yield* live(now);
      const claimedAt = yield* Ref.get(generation);
      // Claimed atomically, so two answers to one request cannot both proceed.
      const entry = yield* Ref.modify(
        waiting,
        (
          current,
        ): readonly [Waiting | OutsideAgentsError | undefined, ReadonlyMap<string, Waiting>] => {
          const found = current.get(id);
          if (found === undefined || found.answer !== undefined || found.claimed)
            return [undefined, current] as const;
          if (input._tag === "approve") {
            if (input.code === undefined)
              return [
                new OutsideAgentsError({
                  message:
                    "Update SSHCode to approve this sign-in with the code from your browser.",
                }),
                current,
              ] as const;
            if (
              !/^[0-9]{4}$/.test(input.code) ||
              !timingSafeEqualText(input.code, found.signIn.code)
            )
              return [
                new OutsideAgentsError({
                  message: "That code does not match this sign-in. Check the page in your browser.",
                }),
                current,
              ] as const;
          }
          const next = new Map(current);
          next.set(id, { ...found, claimed: true });
          return [found, next] as const;
        },
      );
      if (isOutsideAgentsError(entry)) return yield* entry;
      if (entry === undefined) return yield* unavailable;
      const redirect = yield* decide(entry);
      // Only lands if the request survived: not expired, replaced, or dropped by turning off.
      const landed = yield* Effect.flatMap(Ref.get(generation), (current) =>
        Ref.modify(waiting, (map) => {
          const found = map.get(id);
          if (current !== claimedAt || found === undefined || !found.claimed)
            return [false, map] as const;
          const next = new Map(map);
          next.set(id, { ...found, answer: redirect });
          return [true, next] as const;
        }),
      );
      if (!landed) return yield* unavailable;
      yield* publish;
      return yield* state;
    });

  const command: OutsideAgents["Service"]["command"] = (input) => {
    switch (input._tag) {
      case "approve":
        return answer(input, (entry) =>
          oauth.approveInApp(entry.authorization, input.access satisfies AuthMcpClientAccess),
        );
      case "deny":
        return answer(input, (entry) => Effect.succeed(oauth.deny(entry.authorization)));
      case "accept-new":
        return Effect.gen(function* () {
          if (!(yield* enabled)) return yield* off;
          yield* openSignIns;
          yield* publish;
          return yield* state;
        });
      case "stop-accepting":
        return Ref.set(acceptingUntil, 0).pipe(Effect.andThen(publish), Effect.andThen(state));
    }
  };

  // Turning outside agents on opens a sign-in window; turning them off forgets
  // every request and closes it, so nothing can be approved later.
  const wasOn = yield* Ref.make(yield* enabled);
  yield* settings.streamChanges.pipe(
    Stream.runForEach((current) =>
      Effect.gen(function* () {
        const before = yield* Ref.getAndSet(wasOn, current.outsideAgents);
        if (before === current.outsideAgents) return;
        if (current.outsideAgents) {
          yield* openSignIns;
        } else {
          yield* Ref.update(generation, (value) => value + 1);
          yield* Ref.set(waiting, new Map());
          yield* Ref.set(acceptingUntil, 0);
        }
        yield* publish;
      }),
    ),
    Effect.forkScoped,
  );

  return OutsideAgents.of({
    enabled,
    request,
    status,
    state,
    changes: Stream.fromPubSub(changed).pipe(Stream.mapEffect(() => state)),
    command,
  });
});

export const layer = Layer.effect(OutsideAgents, make);
