import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  openCodeGoDatabaseFilename,
  readOpenCodeGoUsageLimits,
  type OpenCodeGoUsageInput,
} from "./usageLimits.ts";

const RESETS_AT = "2026-09-17T12:00:00.000Z";
const INSTANCE_KEY = "instance-key";
const fingerprint = (key: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${key}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  });
/** SHA-256 of `opencode-go\0instance-key`. */
const INSTANCE_FINGERPRINT = "aba48e85c981a8edc1c9fb4575121accc7235fa55d0f8689f66f153de5566a37";
const REJECTED_KEY = "OpenCode Go rejected the saved key. Sign in to OpenCode Go again.";
const UNREADABLE = "OpenCode Go could not read usage.";

const usageBody = {
  usage: {
    rolling: { percent: 0, resetsAt: RESETS_AT },
    weekly: { percent: 10, resetsAt: RESETS_AT },
    monthly: { percent: 40, resetsAt: RESETS_AT },
  },
};

interface CredentialRow {
  readonly id: string;
  readonly integrationId: string;
  readonly label: string;
  readonly value: unknown;
  readonly active: number | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}

/** Fixture keys only. The reader is exercised against this file, never a real account. */
const writeCredentials = (filename: string, rows: readonly CredentialRow[]) => {
  const database = new NodeSqlite.DatabaseSync(filename);
  try {
    database.exec(`
      CREATE TABLE credential (
        id TEXT PRIMARY KEY,
        integration_id TEXT,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        connector_id TEXT,
        method_id TEXT,
        active INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);
    const insert = database.prepare(
      `INSERT INTO credential
        (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.integrationId,
        row.label,
        JSON.stringify(row.value),
        row.active,
        row.timeCreated,
        row.timeUpdated,
      );
    }
  } finally {
    database.close();
  }
};

const keyRow = (
  id: string,
  key: string,
  active: number | null,
  timeCreated: number,
  timeUpdated: number,
  integrationId = "opencode-go",
): CredentialRow => ({
  id,
  integrationId,
  label: id,
  value: { type: "key", key },
  active,
  timeCreated,
  timeUpdated,
});

const goUsage = (input: OpenCodeGoUsageInput, http: HttpClient.HttpClient) =>
  readOpenCodeGoUsageLimits(input).pipe(Effect.provideService(HttpClient.HttpClient, http));

const httpFor = (expectedKey: string | undefined) => {
  const seen: string[] = [];
  const http = HttpClient.make((request) => {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) seen.push(authorization);
    if (expectedKey === undefined) return Effect.die("unexpected usage request");
    assert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(authorization, `Bearer ${expectedKey}`);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usageBody)));
  });
  return { http, seen };
};

const httpStatus = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );

const withData = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "opencode-go-limits-" });
  const data = path.join(home, "opencode");
  yield* fileSystem.makeDirectory(data);
  const environment = { XDG_DATA_HOME: home, HOME: home };
  return { fileSystem, path, home, data, environment };
});

describe("OpenCode Go usage credentials", () => {
  it("names the database file the way OpenCode's databasePath does", () => {
    assert.equal(openCodeGoDatabaseFilename({ environment: {} }), "opencode.db");
    assert.equal(openCodeGoDatabaseFilename({ environment: {}, channel: "beta" }), "opencode.db");
    assert.equal(
      openCodeGoDatabaseFilename({ environment: {}, channel: "localai" }),
      "opencode-localai.db",
    );
    assert.equal(
      openCodeGoDatabaseFilename({
        environment: { OPENCODE_DISABLE_CHANNEL_DB: "1" },
        channel: "localai",
      }),
      "opencode.db",
    );
    assert.equal(
      openCodeGoDatabaseFilename({ environment: { OPENCODE_DB: "custom.db" }, channel: "localai" }),
      "custom.db",
    );
    assert.equal(
      openCodeGoDatabaseFilename({ environment: { OPENCODE_DB: ":memory:" } }),
      undefined,
    );
    assert.equal(
      openCodeGoDatabaseFilename({ environment: {}, channel: "local/ai" }),
      "opencode-local-ai.db",
    );
  });

  it.effect("uses the active Go credential, not the newest or another integration", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [
        keyRow("a", "older-key", 0, 100, 9_999),
        keyRow("m", "newest-created-key", null, 300, 50),
        keyRow("z", INSTANCE_KEY, 1, 200, 200),
        keyRow("other", "other-integration-key", 1, 900, 900, "opencode"),
      ]);
      const { http } = httpFor(INSTANCE_KEY);
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        http,
      );
      assert.equal(limits.unavailable, undefined);
      assert.equal(yield* fingerprint(INSTANCE_KEY), INSTANCE_FINGERPRINT);
      assert.equal(limits.credentialFingerprint, INSTANCE_FINGERPRINT);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("picks the newest legacy row, then the highest id, when none is active", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [
        keyRow("a", "older-key", null, 100, 9_999),
        keyRow("m", "same-time-lower-id", null, 200, 9_999),
        keyRow("z", INSTANCE_KEY, null, 200, 1),
      ]);
      const { http } = httpFor(INSTANCE_KEY);
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        http,
      );
      assert.equal(limits.credentialFingerprint, INSTANCE_FINGERPRINT);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps OpenCode 1 on auth.json and ignores a sibling database", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("z", "database-key", 1, 200, 200)]);
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: INSTANCE_KEY } }),
      );
      for (const generation of [undefined, "v1"] as const) {
        const { http } = httpFor(INSTANCE_KEY);
        const limits = yield* goUsage(
          {
            enabled: true,
            serverUrl: "",
            environment: { ...environment, OPENCODE_API_KEY: "env-key" },
            ...(generation === undefined ? {} : { generation }),
          },
          http,
        );
        assert.equal(limits.credentialFingerprint, INSTANCE_FINGERPRINT);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads auth.json when an official 2.x database is not there yet", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: INSTANCE_KEY } }),
      );
      const { http } = httpFor(INSTANCE_KEY);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
        },
        http,
      );
      assert.equal(limits.credentialFingerprint, INSTANCE_FINGERPRINT);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses OPENCODE_API_KEY when the official store has no Go credential", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [
        keyRow("other", "other-integration-key", 1, 1, 1, "opencode"),
      ]);
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: "stale-key" } }),
      );
      const { http } = httpFor("env-key");
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
        },
        http,
      );
      assert.equal(limits.credentialFingerprint, yield* fingerprint("env-key"));
      assert.isUndefined(limits.unavailable);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace a selected unusable credential with the environment key", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [
        {
          id: "z",
          integrationId: "opencode-go",
          label: "Console",
          value: { type: "oauth", refresh: "not-a-key" },
          active: 1,
          timeCreated: 200,
          timeUpdated: 200,
        },
      ]);
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
        },
        http,
      );
      assert.equal(limits.unavailable?.reason, "unsupported");
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a channel database with no Go key as no subscription", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("z", INSTANCE_KEY, 1, 200, 200)]);
      writeCredentials(path.join(data, "opencode-localai.db"), [
        keyRow("other", "other-integration-key", 1, 1, 1, "opencode"),
      ]);
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: INSTANCE_KEY } }),
      );
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
          channel: "localai",
        },
        http,
      );
      assert.equal(limits.unavailable?.reason, "unsupported");
      assert.isUndefined(limits.unavailable?.message);
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not borrow auth.json when the channel database is missing", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: INSTANCE_KEY } }),
      );
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
          channel: "localai",
        },
        http,
      );
      assert.equal(limits.unavailable?.reason, "unsupported");
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("honors OPENCODE_DB and a stored key over the environment", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("a", "other-key", 1, 1, 1)]);
      writeCredentials(path.join(data, "custom.db"), [keyRow("z", INSTANCE_KEY, 0, 1, 1)]);
      const { http } = httpFor(INSTANCE_KEY);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_DB: "custom.db", OPENCODE_API_KEY: "env-key" },
          generation: "v2",
          channel: "localai",
        },
        http,
      );
      assert.equal(limits.credentialFingerprint, INSTANCE_FINGERPRINT);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats an absolute opencode.db override as the shared store", () =>
    Effect.gen(function* () {
      const { home, data, path, fileSystem, environment } = yield* withData;
      const filename = path.join(home, "elsewhere", "opencode.db");
      yield* fileSystem.makeDirectory(path.join(home, "elsewhere"));
      writeCredentials(filename, []);
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: "stale-key" } }),
      );
      const { http } = httpFor("env-key");
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_DB: filename, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
          channel: "localai",
        },
        http,
      );
      assert.isUndefined(limits.unavailable);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("has nothing to read for an in-memory database", () =>
    Effect.gen(function* () {
      const { environment } = yield* withData;
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: {
            ...environment,
            OPENCODE_DB: ":memory:",
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              "opencode-go": { type: "api", key: INSTANCE_KEY },
            }),
          },
          generation: "v2",
        },
        http,
      );
      assert.equal(limits.unavailable?.reason, "unsupported");
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says to sign in again when Go rejects the saved key", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("z", INSTANCE_KEY, 1, 1, 1)]);
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        httpStatus(401, { error: INSTANCE_KEY }),
      );
      assert.equal(limits.unavailable?.reason, "probeFailed");
      assert.equal(limits.unavailable?.message, REJECTED_KEY);
      assert.equal(JSON.stringify(limits).includes(INSTANCE_KEY), false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a missing Go subscription unsupported", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("z", INSTANCE_KEY, 1, 1, 1)]);
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        httpStatus(403, { error: INSTANCE_KEY }),
      );
      assert.equal(limits.unavailable?.reason, "unsupported");
      assert.isUndefined(limits.unavailable?.message);
      assert.equal(JSON.stringify(limits).includes(INSTANCE_KEY), false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not put the key into a failed usage message or the logs", () =>
    Effect.gen(function* () {
      const { data, path, environment } = yield* withData;
      writeCredentials(path.join(data, "opencode.db"), [keyRow("z", INSTANCE_KEY, 1, 1, 1)]);
      const recorded: string[] = [];
      const logger = Logger.make(({ message }) => {
        recorded.push(typeof message === "string" ? message : JSON.stringify(message));
      });
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        httpStatus(500, { detail: `rejected ${INSTANCE_KEY}` }),
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      assert.equal(limits.unavailable?.reason, "probeFailed");
      assert.equal(limits.unavailable?.message, UNREADABLE);
      const rendered = `${JSON.stringify(limits)}\n${recorded.join("\n")}`;
      assert.equal(rendered.includes(INSTANCE_KEY), false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an unreadable database instead of another account's key", () =>
    Effect.gen(function* () {
      const { data, path, fileSystem, environment } = yield* withData;
      const databasePath = path.join(data, "opencode.db");
      yield* fileSystem.writeFileString(databasePath, "not a database");
      yield* fileSystem.writeFileString(
        path.join(data, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: INSTANCE_KEY } }),
      );
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        {
          enabled: true,
          serverUrl: "",
          environment: { ...environment, OPENCODE_API_KEY: "env-key" },
          generation: "v2",
        },
        http,
      );
      assert.equal(limits.unavailable?.reason, "probeFailed");
      assert.equal(limits.unavailable?.message, UNREADABLE);
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow a database symlink", () =>
    Effect.gen(function* () {
      const { home, data, path, fileSystem, environment } = yield* withData;
      const real = path.join(home, "real.db");
      writeCredentials(real, [keyRow("z", INSTANCE_KEY, 1, 1, 1)]);
      yield* fileSystem.symlink(real, path.join(data, "opencode.db"));
      const { http, seen } = httpFor(undefined);
      const limits = yield* goUsage(
        { enabled: true, serverUrl: "", environment, generation: "v2" },
        http,
      );
      assert.equal(limits.unavailable?.reason, "probeFailed");
      assert.equal(limits.unavailable?.message, UNREADABLE);
      assert.deepEqual(seen, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
