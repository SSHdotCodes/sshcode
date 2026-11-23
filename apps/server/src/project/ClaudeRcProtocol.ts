import type { ClaudeRcEvent, ClaudeRcItem, ClaudeRcSession } from "@t3tools/contracts";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const text = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 64_000);
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const item = record(block);
      if (item.type === "text") return string(item.text);
      if (item.type === "image") return "[Image]";
      if (item.type === "tool_result") return text(item.content);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 64_000);
};

const TOOL_INPUT_STRING_LIMIT = 4_000;
const TOOL_INPUT_JSON_LIMIT = 16_000;
const TOOL_OUTPUT_LIMIT = 32_000;
const REMEMBERED_TOOL_CALLS = 500;

/** Labels need paths, commands and queries, never a whole written file. */
function boundedToolInput(value: unknown): unknown {
  const input = record(value);
  const bounded: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(input))
    bounded[key] =
      typeof field === "string" && field.length > TOOL_INPUT_STRING_LIMIT
        ? `${field.slice(0, TOOL_INPUT_STRING_LIMIT)}…`
        : field;
  return JSON.stringify(bounded).length <= TOOL_INPUT_JSON_LIMIT
    ? bounded
    : Object.fromEntries(
        Object.entries(bounded).filter(([, field]) => typeof field !== "object" || field === null),
      );
}

/** Archived husks, cloud runs and SDK workers are deliberately not Terminal sessions. */
export function liveClaudeRcSession(value: unknown): ClaudeRcSession | null {
  const session = record(value),
    config = record(session.config);
  const tags = Array.isArray(session.tags) ? session.tags : [];
  if (
    !/^cse_[A-Za-z0-9]+$/.test(string(session.id)) ||
    session.environment_kind !== "bridge" ||
    session.status !== "active" ||
    session.connection_status !== "connected" ||
    // An interactive CLI that inherited an agent's markers (its Terminal was
    // opened from inside one) reports the SDK origin, but only the CLI's
    // prompt tags its session as a REPL.
    (config.origin !== "claude_code_cli" && !tags.includes("remote-control-repl")) ||
    tags.includes("remote-control-sdk")
  )
    return null;
  return {
    id: string(session.id),
    title: string(session.title) || "Claude Code CLI",
    updatedAt: string(session.updated_at),
    working: session.worker_status === "running",
  };
}

export interface RcFrame {
  readonly event: string;
  readonly data: string;
  readonly id: string;
}
/** Handles split UTF-8/CRLF chunks and multiline SSE data without buffering the whole stream. */
export class RcSseParser {
  private buffer = "";
  push(chunk: string): RcFrame[] {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error("Remote Control frame is too large.");
    const frames: RcFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) return frames;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = "message",
        id = "";
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon),
          value = line.slice(colon + 1).replace(/^ /, "");
        if (name === "event") event = value;
        if (name === "id") id = value;
        if (name === "data") data.push(value);
      }
      if (data.length > 0 || event === "catch_up_truncated")
        frames.push({ event, id, data: data.join("\n") });
    }
  }
}

export interface RcPendingPermission {
  readonly requestId: string;
  readonly input: Record<string, unknown>;
  readonly toolUseId?: string;
}

/** Only worker-authored frames can request approvals or change execution state. */
export class RcEventDecoder {
  readonly permissions = new Map<string, RcPendingPermission>();
  private streamingId = "";
  private working: boolean;
  /** Results arrive in a later user frame; pairing them keeps one row per call. */
  private readonly toolCalls = new Map<string, ClaudeRcItem>();

  constructor(working = false) {
    this.working = working;
  }

  private rememberToolCall(item: ClaudeRcItem) {
    this.toolCalls.delete(item.id);
    this.toolCalls.set(item.id, item);
    if (this.toolCalls.size > REMEMBERED_TOOL_CALLS)
      this.toolCalls.delete(this.toolCalls.keys().next().value!);
  }

  private toolResults(content: ReadonlyArray<unknown>, id: string): ClaudeRcEvent[] {
    const events: ClaudeRcEvent[] = [];
    content.forEach((block, index) => {
      const result = record(block);
      if (result.type !== "tool_result") return;
      const output = text(result.content).slice(0, TOOL_OUTPUT_LIMIT);
      const failed = result.is_error === true;
      const toolUseId = string(result.tool_use_id);
      const call = toolUseId ? this.toolCalls.get(toolUseId) : undefined;
      const item: ClaudeRcItem = call?.tool
        ? {
            ...call,
            text: output ? `${call.text}\n\n${output}` : call.text,
            tool: { ...call.tool, output, failed, done: true },
          }
        : {
            id: toolUseId || `${id}:result:${index}`,
            role: "tool",
            text: output,
            tool: { name: "", output, failed, done: true },
          };
      if (call) this.rememberToolCall(item);
      events.push({ type: "item", item });
    });
    return events;
  }

  decode(frame: RcFrame): ClaudeRcEvent[] {
    if (frame.event === "catch_up_truncated") {
      this.streamingId = "";
      return [
        {
          type: "item",
          item: {
            id: "rc-recent-history",
            role: "notice",
            text: "Showing recent output. The CLI keeps the full conversation.",
          },
        },
      ];
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = record(JSON.parse(frame.data));
    } catch {
      return [];
    }
    if (frame.event === "session_update") {
      if (envelope.connection_status === "disconnected")
        return [
          {
            type: "status",
            phase: "disconnected",
            working: false,
            message: "This CLI session disconnected. Reconnect it in Claude Code.",
          },
        ];
      return [];
    }
    if (frame.event === "delivery_update") {
      if (envelope.status === "DELIVERY_STATUS_PROCESSING") this.working = true;
      if (envelope.status === "DELIVERY_STATUS_PROCESSED") this.working = false;
      return [{ type: "status", phase: "connected", working: this.working }];
    }
    if (frame.event !== "client_event" && frame.event !== "ephemeral_event") return [];
    const payload = record(envelope.payload);
    const worker = envelope.source === "worker";
    const id = string(payload.uuid) || string(envelope.event_id) || frame.id;
    if (payload.type === "user") {
      const message = record(payload.message);
      const content = message.content;
      if (
        !worker &&
        (payload.tool_use_result !== undefined ||
          (typeof content === "string" && /<local-command-(stdout|stderr)>/.test(content)))
      )
        return [];
      if (
        !worker &&
        typeof content !== "string" &&
        (!Array.isArray(content) || content.some((block) => record(block).type !== "text"))
      )
        return [];
      if (Array.isArray(content) && content.some((block) => record(block).type === "tool_result"))
        return this.toolResults(content, id);
      const body = text(content);
      return body ? [{ type: "item", item: { id, role: "user", text: body } }] : [];
    }
    if (!worker) return [];
    // We never send initialize, so no control response is an authoritative approval snapshot.
    if (payload.type === "control_response") return [];
    if (payload.type === "assistant") {
      const message = record(payload.message);
      const messageId = string(message.id) || id;
      const items: ClaudeRcEvent[] = [];
      const body = text(message.content);
      if (body)
        items.push({ type: "item", item: { id: messageId, role: "assistant", text: body } });
      const meta = new Map<string, Record<string, unknown>>();
      if (Array.isArray(payload.tool_use_meta))
        for (const entry of payload.tool_use_meta) {
          const fields = record(entry);
          if (typeof fields.id === "string") meta.set(fields.id, fields);
        }
      if (Array.isArray(message.content))
        for (const block of message.content) {
          const tool = record(block);
          if (tool.type === "tool_use") {
            const toolId = string(tool.id);
            const fields = meta.get(toolId);
            const presentation = mcpToolPresentation({
              toolName: string(tool.name).replace(/^mcp__claude_ai_/u, "mcp__"),
              title: fields?.display_name,
              serverDisplayName: fields?.server_display_name,
              iconUrl: fields?.icon_url,
            });
            const item: ClaudeRcItem = {
              id: toolId || `${id}:tool`,
              role: "tool",
              text: `${string(tool.name)}\n${JSON.stringify(tool.input ?? {}).slice(0, 16_000)}`,
              tool: {
                name: string(tool.name),
                input: boundedToolInput(tool.input),
                ...(presentation.title ? { title: presentation.title } : {}),
                ...(presentation.toolSource ? { source: presentation.toolSource } : {}),
              },
            };
            this.rememberToolCall(item);
            items.push({ type: "item", item });
          }
        }
      return items;
    }
    if (payload.type === "stream_event") {
      const event = record(payload.event);
      if (event.type === "message_start") {
        this.streamingId = string(record(event.message).id) || id;
      }
      if (
        event.type === "content_block_delta" &&
        record(event.delta).type === "text_delta" &&
        this.streamingId
      ) {
        return [
          {
            type: "textDelta",
            id: this.streamingId,
            text: string(record(event.delta).text).slice(0, 64_000),
          },
        ];
      }
      return [];
    }
    if (payload.type === "control_request") {
      const request = record(payload.request),
        requestId = string(payload.request_id);
      if (request.subtype === "can_use_tool" && requestId) {
        if (request.requires_user_interaction === true) {
          this.permissions.delete(requestId);
          return [
            { type: "permissionResolved", requestId },
            {
              type: "item",
              item: {
                id: requestId,
                role: "notice",
                text: "Claude needs your input for this action. Answer in the CLI for now.",
              },
            },
          ];
        }
        this.permissions.set(requestId, {
          requestId,
          input: record(request.input),
          ...(typeof request.tool_use_id === "string" ? { toolUseId: request.tool_use_id } : {}),
        });
        return [
          {
            type: "permission",
            permission: {
              requestId,
              toolName: string(request.tool_name),
              description: JSON.stringify(request.input ?? {}).slice(0, 16_000),
            },
          },
        ];
      }
      if (request.subtype === "request_user_dialog" || request.subtype === "elicitation")
        return [
          {
            type: "item",
            item: {
              id: requestId,
              role: "notice",
              text: "Claude is asking for input. Answer this dialog in the CLI for now.",
            },
          },
        ];
      return [];
    }
    if (payload.type === "control_cancel_request") {
      const requestId = string(payload.request_id);
      this.permissions.delete(requestId);
      return [{ type: "permissionResolved", requestId }];
    }
    if (payload.type === "result") {
      this.working = false;
      const events: ClaudeRcEvent[] = [{ type: "status", phase: "connected", working: false }];
      for (const requestId of this.permissions.keys())
        events.push({ type: "permissionResolved", requestId });
      this.permissions.clear();
      if (payload.is_error === true)
        events.push({
          type: "item",
          item: {
            id,
            role: "notice",
            text:
              string(payload.result) ||
              text(payload.errors) ||
              "Claude Code reported an error. Check the CLI.",
          },
        });
      return events;
    }
    if (payload.type === "system" && payload.subtype === "session_state_changed") {
      this.working = payload.state === "running";
      if (payload.state === "requires_action")
        return [
          {
            type: "status",
            phase: "connected",
            working: false,
            message: "Claude needs your input. Check the approval below or answer in the CLI.",
          },
        ];
      return [{ type: "status", phase: "connected", working: this.working }];
    }
    if (payload.type === "system" && payload.subtype === "status") {
      const status = string(payload.status);
      this.working = status === "running" || status === "compacting";
      return [{ type: "status", phase: "connected", working: this.working }];
    }
    if (payload.type === "system" && payload.subtype === "local_command_output") {
      return [
        {
          type: "item",
          item: { id, role: "notice", text: string(payload.content).slice(0, 64_000) },
        },
      ];
    }
    return [];
  }
}
