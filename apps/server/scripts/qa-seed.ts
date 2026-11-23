// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off - Sandbox-only CLI boundary; credentials stay in memory.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { QaSandboxHostError } from "../src/preview/QaSandboxHost.ts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";

const [directory, port] = process.argv.slice(2);
if (
  !process.env.T3CODE_QA_SANDBOX ||
  directory !== `/private/tmp/t3-qa-${process.env.T3CODE_QA_SANDBOX}` ||
  port !== process.env.T3CODE_PORT
) {
  throw new Error("QA seed requires its sandbox environment.");
}
const origin = `http://127.0.0.1:${port}`;
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
await exec("/usr/bin/git", ["init", "-q", NodePath.join(directory, "project")]);
const paired = await exec(process.execPath, [
  "src/bin.ts",
  "auth",
  "pairing",
  "create",
  "--base-dir",
  NodePath.join(directory, "base"),
  "--ttl",
  "30m",
  "--json",
]);
const { credential } = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }))(
  JSON.parse(paired.stdout),
);
const response = await fetch(`${origin}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  }),
});
if (!response.ok) throw new Error(`QA authentication: ${response.status}`);
const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
  await response.json(),
);
const headers = {
  Authorization: `Bearer ${token.access_token}`,
  "Content-Type": "application/json",
  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
};
const projectId = ProjectId.make(NodeCrypto.randomUUID());
const created = await fetch(`${origin}/api/projects/mutate`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    type: "project.create",
    commandId: NodeCrypto.randomUUID(),
    projectId,
    title: "QA sandbox",
    workspaceRoot: NodePath.join(directory, "project"),
  }),
});
if (!created.ok) throw new Error(`QA project: ${created.status} ${await created.text()}`);
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers,
});
const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
  await ticketResponse.json(),
);
const socket = Socket.layerWebSocket(
  `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));
const protocol = RpcClient.layerProtocolSocket({ pingTimeout: "30 seconds" }).pipe(
  Layer.provide(socket),
  Layer.provide(RpcSerialization.layerJson),
);
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      projectId,
      threadId,
      title: "QA fixture chat",
      modelSelection: {
        instanceId: ProviderInstanceId.make("acpRegistry_qa"),
        model: "qa-balanced",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "Show the sandbox fixture.", attachments: [] },
    });
    yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.mapEffect((item) =>
        item.kind === "snapshot"
          ? Effect.succeed(item.projection)
          : client["orchestration.getThreadProjection"]({ threadId }),
      ),
      Stream.tap((projection) =>
        projection.runs.some((run) => run.status === "failed")
          ? Effect.fail(new QaSandboxHostError({ stage: "seed", cause: "Fixture turn failed." }))
          : Effect.void,
      ),
      Stream.filter((projection) => projection.runs.some((run) => run.status === "completed")),
      Stream.tap((projection) =>
        projection.messages.some((message) => message.role === "assistant") &&
        projection.turnItems.length > 0
          ? Effect.void
          : Effect.fail(
              new QaSandboxHostError({ stage: "seed", cause: "Fixture transcript is incomplete." }),
            ),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("25 seconds")),
);
