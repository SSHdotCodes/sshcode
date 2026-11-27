import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { TeamBoard } from "../teamBoard/TeamBoard.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { mcpRequestIds, rewriteMcpResponseBody } from "./AgentToolCatalog.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const appendBoardToolResult = (
  body: string,
  calls: ReadonlySet<string>,
  reserve: () => string | undefined,
) =>
  rewriteMcpResponseBody(body, (payload) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      return undefined;
    }
    const decorate = (message: unknown) => {
      if (
        !record(message) ||
        message.jsonrpc !== "2.0" ||
        (typeof message.id !== "string" && typeof message.id !== "number") ||
        !calls.has(String(message.id)) ||
        !record(message.result) ||
        !Array.isArray(message.result.content)
      )
        return message;
      const text = reserve();
      if (text === undefined) return message;
      const { result } = message;
      return {
        ...message,
        result: {
          ...result,
          content: [...(result.content as unknown[]), { type: "text", text }],
          // Claude Code prefers structuredContent when the tool returns both forms.
          ...(record(result.structuredContent)
            ? {
                structuredContent: { ...result.structuredContent, _sshcodeTeamBoard: text },
              }
            : {}),
        },
      };
    };
    if (!Array.isArray(decoded)) {
      const next = decorate(decoded);
      return next === decoded ? payload : JSON.stringify(next);
    }
    const next = decoded.map(decorate);
    return next.every((item, index) => item === decoded[index]) ? payload : JSON.stringify(next);
  });

export const attachBoardToolResults = (
  response: HttpServerResponse.HttpServerResponse,
  scope: McpInvocationScope,
  board: TeamBoard["Service"] | undefined,
) =>
  Effect.gen(function* () {
    const id = scope.thread?.threadId;
    if (id === undefined || !board?.hasNotices(id)) return response;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const calls = mcpRequestIds(
      yield* request.text.pipe(Effect.orElseSucceed(() => "")),
      "tools/call",
    );
    if (calls === undefined) return response;
    const attach = (text: string) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          let delivery: ReturnType<typeof board.reserveNotices>;
          const rewritten = appendBoardToolResult(text, calls, () => {
            if (delivery !== undefined) return undefined;
            delivery = board.reserveNotices(id);
            return delivery?.text;
          });
          if (delivery !== undefined) yield* delivery.finish(true);
          return rewritten;
        }),
      );
    const body = response.body;
    const decoder = new TextDecoder();
    if (body._tag === "Uint8Array") {
      const text = body.text ?? decoder.decode(body.body);
      const next = yield* attach(text);
      return next === text
        ? response
        : HttpServerResponse.setBody(response, HttpBody.text(next, body.contentType));
    }
    if (body._tag !== "Stream") return response;
    return HttpServerResponse.setBody(
      response,
      HttpBody.stream(
        Stream.mapEffect(body.stream, (chunk) => {
          const text = decoder.decode(chunk);
          return attach(text).pipe(
            Effect.map((next) => (next === text ? chunk : Buffer.from(next))),
          );
        }),
        body.contentType,
      ),
    );
  });
