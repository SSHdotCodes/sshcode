import type {
  ProviderDriverKind,
  ProviderReplayEntry,
  ProviderReplayTranscript,
} from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

/** Adds current runtime context to legacy prompt expectations, keeping outbound matching exact. */
export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "muse"
            ? "Muse Code"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  const acpRuntime = buildRuntimeInstructions({ harness: "ACP" });
  const bootstrapped = new Set<string>();
  let cursorBootstrapped = false;
  let museBootstrapped = false;

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      // Each opened agent is a new context and bootstraps runtime context again.
      if (runtime.driver === "cursor" && "type" in frame && frame.type === "agent.open") {
        cursorBootstrapped = false;
        return entry;
      }
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        // Cursor bootstraps runtime context once per opened context; slash commands stay bare.
        const bare = frame.message.endsWith(`\n\n${instructions}`)
          ? frame.message.slice(0, -`\n\n${instructions}`.length)
          : frame.message;
        if (cursorBootstrapped || bare.trimStart().startsWith("/"))
          return { ...entry, frame: { ...frame, message: bare } };
        cursorBootstrapped = true;
        return { ...entry, frame: { ...frame, message: `${bare}\n\n${instructions}` } };
      }
      if (runtime.driver === "muse") {
        // Muse sends runtime context with its first accepted user turn only.
        let sawRuntime = false;
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) {
            return value.flatMap((part: unknown) => {
              if (
                typeof part === "object" &&
                part !== null &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string" &&
                part.text.startsWith("<runtime_info>")
              ) {
                sawRuntime = true;
                // Muse joins text parts with nothing between them, so the adapter ends this one
                // with a blank line.
                return museBootstrapped ? [] : [{ ...part, text: `${instructions}\n\n` }];
              }
              return [rewrite(part)];
            });
          }
          if (typeof value === "object" && value !== null) {
            return Object.fromEntries(
              Object.entries(value).map(([key, inner]) => [key, rewrite(inner)]),
            );
          }
          return value;
        };
        const rewritten = rewrite(frame);
        if (!sawRuntime) return entry;
        museBootstrapped = true;
        return { ...entry, frame: rewritten as typeof frame };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        // ACP delivers runtime context once, inside the first prompt's T3 block.
        const prompt: ReadonlyArray<unknown> = frame.params.prompt.filter(
          (part: unknown) =>
            !(
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string" &&
              part.text.startsWith("<runtime_info>")
            ),
        );
        const sessionId =
          "sessionId" in frame.params && typeof frame.params.sessionId === "string"
            ? frame.params.sessionId
            : "";
        const first = !bootstrapped.has(sessionId);
        bootstrapped.add(sessionId);
        const withRuntime = prompt.map((part, index) => {
          if (
            !first ||
            index !== 0 ||
            typeof part !== "object" ||
            part === null ||
            !("text" in part) ||
            typeof part.text !== "string" ||
            !part.text.startsWith("<t3_code_instructions>\n")
          )
            return part;
          return {
            ...part,
            text: part.text.replace(
              "\n</t3_code_instructions>",
              `\n\n${acpRuntime}\n</t3_code_instructions>`,
            ),
          };
        });
        return {
          ...entry,
          frame: { ...frame, params: { ...frame.params, prompt: withRuntime } },
        };
      }
      return entry;
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Host ordinal from a Muse record label: records of the Nth host (N > 1) end in `@hN`. */
function museEntryHost(entry: ProviderReplayEntry): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@h(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

/**
 * Brings Muse recordings up to what the adapter now sends, keeping outbound matching exact:
 * hosts launch with an explicit `--contributor-mode`, and turns may set the standing effort.
 *
 * Before a `turn/start`, the Muse adapter makes the turn's effort the session's standing default
 * when it differs from what that host last set; a fresh host has set none. The command takes the
 * next client request id and the next minted command id, so later client request ids (and their
 * responses) shift by one. Server requests and the adapter's replies to them keep their ids.
 */
export function materializeMuseReplayAdapterChanges(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  if (transcript.provider !== "muse") return transcript;
  const recordedCommandIds = transcript.metadata?.commandIds;
  if (
    !Array.isArray(recordedCommandIds) ||
    !recordedCommandIds.every(
      (ids: unknown) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
    )
  )
    throw new Error(`${transcript.scenario}: Muse transcript has no commandIds metadata.`);
  const commandIds: Array<Array<string>> = recordedCommandIds.map((ids: Array<string>) => [...ids]);
  const knownIds = new Set(commandIds.flat());
  const standing = new Map<number, string>();
  // Per host: recorded client request id -> its id after earlier insertions.
  const requestIds = new Map<number, Map<number, number>>();
  const shifts = new Map<number, number>();
  const entries: Array<ProviderReplayEntry> = [];

  for (const entry of transcript.entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!isRecord(frame)) {
      entries.push(entry);
      continue;
    }
    const host = museEntryHost(entry);
    const suffix = host === 1 ? "" : `@h${host}`;
    if (entry.type === "expect_outbound" && frame.type === "host_start") {
      standing.delete(host);
      requestIds.set(host, new Map());
      shifts.set(host, 0);
      // Hosts now always say their contributor mode; recordings left it to the saved setting,
      // and no replay fixture switches it on.
      const args = Array.isArray(frame.args) ? frame.args : [];
      entries.push(
        args[0] === "serve" && !args.includes("--contributor-mode")
          ? {
              ...entry,
              frame: { ...frame, args: ["serve", "--contributor-mode", "off", ...args.slice(1)] },
            }
          : entry,
      );
      continue;
    }
    const ids = requestIds.get(host) ?? new Map<number, number>();
    requestIds.set(host, ids);
    if (
      entry.type === "expect_outbound" &&
      typeof frame.method === "string" &&
      typeof frame.id === "number"
    ) {
      const recordedId = frame.id;
      const params = isRecord(frame.params) ? frame.params : {};
      const effort = params.reasoningEffort;
      if (
        frame.method === "turn/start" &&
        typeof effort === "string" &&
        standing.get(host) !== effort
      ) {
        const turnCommandId = typeof params.commandId === "string" ? params.commandId : "";
        const hostIds = commandIds[host - 1] ?? [];
        const mintIndex = hostIds.indexOf(turnCommandId);
        if (mintIndex < 0)
          throw new Error(
            `${transcript.scenario}: turn/start ${recordedId} has no minted commandId.`,
          );
        // The adapter mints the effort command's id just before the turn's own.
        const commandId = `${turnCommandId.slice(0, -12)}000000000000`;
        if (knownIds.has(commandId))
          throw new Error(`${transcript.scenario}: synthesized commandId ${commandId} collides.`);
        knownIds.add(commandId);
        hostIds.splice(mintIndex, 0, commandId);
        const id = recordedId + (shifts.get(host) ?? 0);
        shifts.set(host, (shifts.get(host) ?? 0) + 1);
        standing.set(host, effort);
        entries.push(
          {
            type: "expect_outbound",
            label: `session/setReasoningEffort${suffix}`,
            frame: {
              jsonrpc: "2.0",
              id,
              method: "session/setReasoningEffort",
              params: { sessionId: params.sessionId, reasoningEffort: effort, commandId },
            },
          },
          {
            type: "emit_inbound",
            label: `response:session/setReasoningEffort${suffix}`,
            frame: { jsonrpc: "2.0", id, result: { commandId, status: "accepted" } },
          },
        );
      }
      const id = recordedId + (shifts.get(host) ?? 0);
      ids.set(recordedId, id);
      entries.push(id === recordedId ? entry : { ...entry, frame: { ...frame, id } });
      continue;
    }
    // Responses to client requests: inbound frames with an id and no method.
    if (
      entry.type === "emit_inbound" &&
      frame.method === undefined &&
      typeof frame.id === "number"
    ) {
      const id = ids.get(frame.id);
      entries.push(
        id === undefined || id === frame.id ? entry : { ...entry, frame: { ...frame, id } },
      );
      continue;
    }
    entries.push(entry);
  }
  return { ...transcript, metadata: { ...transcript.metadata, commandIds }, entries };
}
