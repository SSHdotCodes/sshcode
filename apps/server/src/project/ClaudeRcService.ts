// @effect-diagnostics nodeBuiltinImport:off -- RC event IDs use the same UUID format as the native CLI.
import * as NodeCrypto from "node:crypto";
import {
  ClaudeRcError,
  type ClaudeRcCommand,
  type ClaudeRcEvent,
  type ClaudeRcSession,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProcessRunner from "../processRunner.ts";
import { liveClaudeRcSession, RcEventDecoder, RcSseParser, record } from "./ClaudeRcProtocol.ts";

const BASE = "https://api.anthropic.com/v1/code/sessions";
const decodeCredentialJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const failure = (message: string) => new ClaudeRcError({ message });
const isRcError = Schema.is(ClaudeRcError);
export type ClaudeRcInputPlatform = "desktop_app" | "ios" | "android";
export function claudeRcInputPlatform(surface: unknown, os: unknown): ClaudeRcInputPlatform | null {
  if (surface === "desktop") return "desktop_app";
  if (surface === "mobile" && os === "iOS") return "ios";
  if (surface === "mobile" && os === "Android") return "android";
  return null;
}
const safeFailure = (error: unknown) =>
  isRcError(error)
    ? error
    : failure("Could not connect to Claude Code Remote Control. Reconnect and try again.");

/** Client-side RC only: never calls /bridge, registers a worker, or starts a model process. */
export class ClaudeRcClient {
  private readonly decoders = new Map<string, Set<RcEventDecoder>>();
  private readonly subscribers = new Map<string, Set<(event: ClaudeRcEvent) => void>>();
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request;
  }

  private headers(token: string, platform = "sshcode") {
    return {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-client-platform": platform,
      "User-Agent": "SSHCode/terminal-rc",
      "Content-Type": "application/json",
    };
  }
  private async check(response: Response) {
    if (response.ok) return;
    await response.body?.cancel();
    if (response.status === 401)
      throw failure(
        "Claude Code's login expired. Sign in again in the CLI, then refresh Terminal.",
      );
    if (response.status === 403)
      throw failure(
        "This Claude login cannot use Remote Control. Check Remote Control in the CLI.",
      );
    if (response.status === 404)
      throw failure("This CLI session is no longer available. Refresh Terminal.");
    throw failure(`Claude Remote Control returned HTTP ${response.status}. Try again.`);
  }
  async sessions(token: string, signal?: AbortSignal): Promise<readonly ClaudeRcSession[]> {
    const sessions = new Map<string, ClaudeRcSession>();
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const url = new URL(BASE);
      url.searchParams.set("limit", "100");
      url.searchParams.set("statuses", "active");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.request(url, {
        headers: this.headers(token),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      });
      await this.check(response);
      const body = record(await response.json());
      if (!Array.isArray(body.data))
        throw failure("Claude returned an unreadable Remote Control session list.");
      for (const raw of body.data) {
        const session = liveClaudeRcSession(raw);
        if (session) sessions.set(session.id, session);
      }
      const next = typeof body.next_cursor === "string" ? body.next_cursor : "";
      if (!next || next === cursor)
        return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      cursor = next;
    }
    throw failure(
      "Claude returned too many session pages. Close old CLI sessions and refresh Terminal.",
    );
  }
  private async liveSession(token: string, sessionId: string, signal?: AbortSignal) {
    const session = (await this.sessions(token, signal)).find((entry) => entry.id === sessionId);
    if (session === undefined)
      throw failure(
        "This is not an open Claude Code CLI session with Remote Control enabled. Refresh Terminal.",
      );
    return session;
  }
  private async post(
    token: string,
    sessionId: string,
    payload: Record<string, unknown>,
    platform: ClaudeRcInputPlatform,
    signal?: AbortSignal,
  ) {
    const response = await this.request(`${BASE}/${sessionId}/events`, {
      method: "POST",
      headers: this.headers(token, platform),
      body: JSON.stringify({
        session_id: sessionId,
        events: [{ payload: { ...payload, uuid: NodeCrypto.randomUUID() } }],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    await this.check(response);
    await response.body?.cancel();
  }
  async command(
    token: string,
    input: ClaudeRcCommand,
    platform: ClaudeRcInputPlatform | null,
    signal?: AbortSignal,
  ) {
    if (!platform) throw failure("Control CLI sessions from the SSHCode Mac or mobile app.");
    await this.liveSession(token, input.sessionId, signal);
    if (input.action === "send") {
      if (!input.text.trim()) throw failure("Enter a message for the CLI.");
      await this.post(
        token,
        input.sessionId,
        {
          type: "user",
          origin: { kind: "human" },
          parent_tool_use_id: null,
          message: { role: "user", content: input.text },
        },
        platform,
        signal,
      );
    } else if (input.action === "interrupt") {
      await this.post(
        token,
        input.sessionId,
        {
          type: "control_request",
          request_id: NodeCrypto.randomUUID(),
          request: { subtype: "interrupt", cancel_queued: true },
        },
        platform,
        signal,
      );
    } else {
      const decoders = this.decoders.get(input.sessionId);
      const pending = [...(decoders ?? [])]
        .map((decoder) => decoder.permissions.get(input.requestId))
        .find(Boolean);
      if (!pending)
        throw failure("This permission prompt is no longer pending. Reconnect to check the CLI.");
      await this.post(
        token,
        input.sessionId,
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: input.requestId,
            response: input.allow
              ? { behavior: "allow", updatedInput: pending.input, toolUseID: pending.toolUseId }
              : {
                  behavior: "deny",
                  message: "The user denied this action in SSHCode.",
                  toolUseID: pending.toolUseId,
                },
          },
        },
        platform,
        signal,
      );
      for (const decoder of decoders ?? []) decoder.permissions.delete(input.requestId);
      for (const emit of this.subscribers.get(input.sessionId) ?? [])
        emit({ type: "permissionResolved", requestId: input.requestId });
    }
  }
  async watch(
    token: string,
    sessionId: string,
    signal: AbortSignal,
    emit: (event: ClaudeRcEvent) => void,
  ) {
    emit({ type: "status", phase: "connecting", working: false });
    const session = await this.liveSession(token, sessionId, signal);
    const response = await this.request(`${BASE}/${sessionId}/events/stream`, {
      headers: { ...this.headers(token), Accept: "text/event-stream" },
      signal,
    });
    await this.check(response);
    if (!response.body) throw failure("Claude Remote Control did not open an event stream.");
    const decoder = new RcEventDecoder(session.working);
    const active = this.decoders.get(sessionId) ?? new Set<RcEventDecoder>();
    active.add(decoder);
    this.decoders.set(sessionId, active);
    const subscribers =
      this.subscribers.get(sessionId) ?? new Set<(event: ClaudeRcEvent) => void>();
    subscribers.add(emit);
    this.subscribers.set(sessionId, subscribers);
    const reader = response.body.getReader(),
      utf8 = new TextDecoder(),
      parser = new RcSseParser();
    emit({ type: "status", phase: "connected", working: session.working });
    try {
      // Watching is read-only. Do not initialize the CLI or negotiate its dialog/settings policy.
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          if (signal.aborted) return;
          throw failure("The Remote Control connection closed. Reconnect to the CLI.");
        }
        for (const frame of parser.push(utf8.decode(value, { stream: true }))) {
          for (const event of decoder.decode(frame)) emit(event);
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      active.delete(decoder);
      if (active.size === 0) this.decoders.delete(sessionId);
      subscribers.delete(emit);
      if (subscribers.size === 0) this.subscribers.delete(sessionId);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export class ClaudeRcService extends Context.Service<
  ClaudeRcService,
  {
    readonly sessions: Effect.Effect<readonly ClaudeRcSession[], ClaudeRcError>;
    readonly command: (
      input: ClaudeRcCommand,
      platform: ClaudeRcInputPlatform | null,
    ) => Effect.Effect<void, ClaudeRcError>;
    readonly watch: (sessionId: string) => Stream.Stream<ClaudeRcEvent, ClaudeRcError>;
  }
>()("t3/project/ClaudeRcService") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const env = yield* HostProcess.Environment,
    home = yield* HostProcess.HomeDirectory,
    platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner,
    crypto = yield* Crypto.Crypto;
  const client = new ClaudeRcClient();
  const token = Effect.gen(function* () {
    // Follow the native CLI environment, independently of SSHCode's provider settings.
    const custom = env.CLAUDE_CONFIG_DIR?.trim();
    const directory = custom
      ? path.resolve(custom.replace(/^~(?=\/|$)/, home))
      : path.join(home, ".claude");
    let raw = "";
    if (platform === "darwin") {
      const suffix = custom
        ? `-${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(directory.normalize("NFC")))).slice(0, 8)}`
        : "";
      const result = yield* runner.run({
        command: "/usr/bin/security",
        args: [
          "find-generic-password",
          "-s",
          `Claude Code-credentials${suffix}`,
          "-a",
          env.USER || env.LOGNAME || "claude-code-user",
          "-w",
        ],
        timeout: "20 seconds",
        maxOutputBytes: 128 * 1024,
      });
      if (result.code === 0) raw = result.stdout;
      else if (result.code !== 44)
        return yield* failure(
          "Allow SSHCode to use the Claude Code login in macOS Keychain, then refresh Terminal.",
        );
    }
    if (!raw)
      raw = yield* fs
        .readFileString(path.join(directory, ".credentials.json"))
        .pipe(
          Effect.mapError(() =>
            failure("Sign in to Claude Code in the CLI to use Remote Control."),
          ),
        );
    const parsed = yield* decodeCredentialJson(raw).pipe(
      Effect.mapError(() =>
        failure("Claude Code's saved login could not be read. Sign in again in the CLI."),
      ),
    );
    const accessToken = record(record(parsed).claudeAiOauth).accessToken;
    if (typeof accessToken !== "string" || !accessToken)
      return yield* failure("Sign in to Claude Code in the CLI to use Remote Control.");
    return accessToken;
  }).pipe(Effect.mapError(safeFailure));
  return ClaudeRcService.of({
    sessions: token.pipe(
      Effect.flatMap((value) =>
        Effect.tryPromise({ try: (signal) => client.sessions(value, signal), catch: safeFailure }),
      ),
    ),
    command: (input, inputPlatform) =>
      token.pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: (signal) => client.command(value, input, inputPlatform, signal),
            catch: safeFailure,
          }),
        ),
      ),
    watch: (sessionId) =>
      Stream.callback<ClaudeRcEvent, ClaudeRcError>((queue) =>
        Effect.gen(function* () {
          const value = yield* token;
          yield* Effect.forkScoped(
            Effect.tryPromise({
              try: (signal) =>
                client.watch(value, sessionId, signal, (event) => {
                  Queue.offerUnsafe(queue, event);
                }),
              catch: safeFailure,
            }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
          );
        }).pipe(Effect.catch((error) => Queue.fail(queue, safeFailure(error)))),
      ),
  });
});
export const layer = Layer.effect(ClaudeRcService, make);
