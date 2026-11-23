// A v1 agent using client terminals without embedding them in its tool calls.
// @effect-diagnostics nodeBuiltinImport:off - the fake ACP process speaks JSON-RPC on stdio.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "devin-client-terminals";
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
const report = (update) => send({ method: "session/update", params: { sessionId, update } });

const cancelFifo = process.argv[2];
let promptId;
function create(name) {
  const command = `sleep 120 & child=$!; echo "$$ $child" > ${name}.fifo; wait "$child"`;
  report({
    sessionUpdate: "tool_call",
    toolCallId: name,
    title: name,
    kind: "execute",
    status: "in_progress",
    rawInput: { command },
  });
  send({
    id: name,
    method: "terminal/create",
    params:
      name === "background"
        ? { sessionId, command: "/bin/sh", args: ["-c", command] }
        : { sessionId, command },
  });
}

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { method, id, result } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "devin", version: "fixture" } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    promptId = id;
    if (!cancelFifo) create("background");
  } else if (id === "background" && result?.terminalId) {
    report({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    create("foreground");
  } else if (method === "session/cancel") {
    if (cancelFifo) NodeFS.writeFileSync(cancelFifo, String(process.pid));
    else send({ id: promptId, result: { stopReason: "cancelled" } });
  } else if (method && id !== undefined) {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
