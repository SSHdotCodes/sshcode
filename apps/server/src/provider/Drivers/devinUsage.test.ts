// @effect-diagnostics-next-line nodeBuiltinImport:off - the fixture is a real SQLite file in a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixture paths only.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeDevinUsageReader } from "./devinUsage.ts";

const decodeConfig = Schema.decodeUnknownSync(AcpRegistrySettings);
const SECOND = 1795052675;

function makeDatabase(dataHome: string) {
  const dir = NodePath.join(dataHome, "devin", "cli");
  NodeFS.mkdirSync(dir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "sessions.db"));
  db.exec(`CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
  );
  const reply = (model: string, metrics: Record<string, unknown>) =>
    JSON.stringify({
      role: "assistant",
      content: "hidden",
      metadata: { generation_model: model, metrics },
    });
  insert.run("session-a", 1, JSON.stringify({ role: "user", content: "hi" }), SECOND);
  insert.run(
    "session-a",
    2,
    reply("swe-2-high", {
      input_tokens: 12298,
      output_tokens: 548,
      cache_read_tokens: 1216,
      cache_creation_tokens: null,
    }),
    SECOND + 5,
  );
  insert.run(
    "session-b",
    7,
    reply("swe-2-max", { input_tokens: 40, output_tokens: 156, cache_read_tokens: 62208 }),
    SECOND + 60,
  );
  // An old reply outside the window.
  insert.run(
    "session-b",
    3,
    reply("swe-2-max", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }),
    SECOND - 86_400,
  );
  db.close();
}

function instance(agentId: string, dataHome: string) {
  return {
    instanceId: ProviderInstanceId.make(`registry-${agentId}`),
    configured: true,
    config: decodeConfig({ agentId }),
    environment: { XDG_DATA_HOME: dataHome },
  };
}

describe("devinUsageReader", () => {
  it.effect("reads each Devin reply's tokens and model, only for Devin instances", () =>
    Effect.gen(function* () {
      const dataHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "devin-usage-"));
      makeDatabase(dataHome);
      const reader = makeDevinUsageReader();
      if (reader.kind !== "scan") throw new Error("Devin usage is a scan reader");
      const scans = yield* reader.scan({
        instances: [instance("devin", dataHome), instance("qwen-code", dataHome)],
        settings: {} as never,
        windowStartMs: (SECOND - 3600) * 1000,
        retentionCutoffMs: (SECOND - 3600) * 1000,
        awaitRefresh: true,
      });
      expect(scans).toHaveLength(1);
      // The account column names the plan, not the instance id.
      expect(scans[0]!.displayName).toBe("Devin");
      const records = scans[0]!.files![0]!.records;
      expect(records.map((record) => [record.model, record.sessionId, record.timestampMs])).toEqual(
        [
          ["swe-2-high", "session-a", (SECOND + 5) * 1000],
          ["swe-2-max", "session-b", (SECOND + 60) * 1000],
        ],
      );
      expect(records[0]!.provider).toBe("devin");
      expect(records[0]!.totals).toEqual({
        uncachedInputTokens: 12298,
        cachedInputTokens: 1216,
        cacheCreationTokens: 0,
        outputTokens: 548,
        reasoningTokens: 0,
      });
      expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(2);
      NodeFS.rmSync(dataHome, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing database as no source", () =>
    Effect.gen(function* () {
      const dataHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "devin-usage-none-"));
      const reader = makeDevinUsageReader();
      if (reader.kind !== "scan") throw new Error("Devin usage is a scan reader");
      const scans = yield* reader.scan({
        instances: [instance("devin", dataHome)],
        settings: {} as never,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      });
      expect(scans).toEqual([
        {
          dir: NodePath.join(dataHome, "devin", "cli"),
          instanceId: "registry-devin",
          displayName: "Devin",
          files: null,
        },
      ]);
      NodeFS.rmSync(dataHome, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
