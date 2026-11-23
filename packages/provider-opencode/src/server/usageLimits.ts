import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const KeyCredential = Schema.Struct({ type: Schema.Literal("key"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const decodeKeyCredential = Schema.decodeUnknownOption(Schema.fromJsonString(KeyCredential));
const decodeKeyObject = Schema.decodeUnknownOption(KeyCredential);
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

const REJECTED_KEY_MESSAGE = "OpenCode Go rejected the saved key. Sign in to OpenCode Go again.";
const UNREADABLE_MESSAGE = "OpenCode Go could not read usage.";

/**
 * Official channels share `opencode.db`. Any other channel, such as `localai`,
 * gets `opencode-<channel>.db`. Matches OpenCode's `databasePath`.
 */
const SHARED_CHANNELS = new Set(["latest", "dev", "beta", "next", "prod"]);

export interface OpenCodeGoUsageInput {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * `v2` reads the credential database. Omitted and `v1` keep `auth.json`.
   * A failed version probe leaves this unset, so it stays on the 1.x file.
   */
  readonly generation?: "v1" | "v2";
  /**
   * Channel from a custom build's version (`2.0.28-localai.1` → `localai`).
   * Unset for an official build, which shares `opencode.db`.
   */
  readonly channel?: string;
}

/**
 * Database file for a 2.x install. `OPENCODE_DB` and `OPENCODE_DISABLE_CHANNEL_DB`
 * follow OpenCode. `:memory:` is a process-local database, so there is nothing
 * on disk to read.
 */
export function openCodeGoDatabaseFilename(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly channel?: string;
}): string | undefined {
  const override = input.environment.OPENCODE_DB?.trim();
  if (override === ":memory:") return undefined;
  if (override) return override;
  if (
    input.environment.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    input.environment.OPENCODE_DISABLE_CHANNEL_DB === "true"
  ) {
    return "opencode.db";
  }
  const channel = input.channel?.trim();
  if (channel === undefined || channel.length === 0 || SHARED_CHANNELS.has(channel)) {
    return "opencode.db";
  }
  return `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`;
}

/** The official database is `opencode.db`, including when `OPENCODE_DB` is an absolute path. */
function isSharedDatabase(filename: string): boolean {
  return filename.split(/[/\\]/).at(-1) === "opencode.db";
}

type StoredGoCredential =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unusable" }
  | { readonly _tag: "Key"; readonly key: string }
  | { readonly _tag: "Unread" };

/**
 * OpenCode lists credentials `ORDER BY active ASC, time_created ASC, id ASC`
 * and uses the last row. SQLite orders NULL first, so the reverse order is
 * that row: an active flag, then the newest, then the highest id. A flagged
 * row beats a newer legacy row that has no flag.
 */
const SELECTED_GO_CREDENTIAL = `
  SELECT value FROM credential
  WHERE integration_id = 'opencode-go'
  ORDER BY active DESC, time_created DESC, id DESC
  LIMIT 1
`;

function credentialKey(value: unknown): string | undefined {
  const decoded = typeof value === "string" ? decodeKeyCredential(value) : decodeKeyObject(value);
  if (Option.isNone(decoded)) return undefined;
  const key = decoded.value.key.trim();
  return key.length > 0 ? key : undefined;
}

/**
 * Read-only. The caller has already checked that the file is there.
 * The key stays in the returned value and is never logged. A failure,
 * including a lock or a file that is not a database, is unreadable.
 */
function readStoredGoCredential(filename: string): StoredGoCredential {
  try {
    const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true, timeout: 200 });
    try {
      database.exec("PRAGMA query_only = ON");
      const table = database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'credential'",
        )
        .get();
      if (table === undefined) return { _tag: "Missing" };
      const row = database.prepare(SELECTED_GO_CREDENTIAL).get() as
        | { readonly value: unknown }
        | undefined;
      if (row === undefined) return { _tag: "Empty" };
      const key = credentialKey(row.value);
      return key === undefined ? { _tag: "Unusable" } : { _tag: "Key", key };
    } finally {
      database.close();
    }
  } catch {
    return { _tag: "Unread" };
  }
}

const readLegacyGoKey = Effect.fn("readLegacyGoKey")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly dataDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = path.join(input.dataDirectory, "auth.json");
  const contents =
    input.environment.OPENCODE_AUTH_CONTENT ||
    (yield* fs.readFileString(authPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    ));
  const auth = yield* decodeAuthFile(contents);
  const apiAuth = decodeApiAuth(auth["opencode-go"]);
  // OpenCode overlays stored API credentials after environment credentials.
  const apiKey = (
    Option.isSome(apiAuth) ? apiAuth.value.key : input.environment.OPENCODE_API_KEY
  )?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : undefined;
});

const fetchGoUsage = Effect.fn("fetchGoUsage")(function* (input: {
  readonly apiKey: string;
  readonly checkedAt: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
      HttpClientRequest.bearerToken(input.apiKey),
    ),
  );
  // A valid Zen key can exist without a Go subscription.
  if (response.status === 403) {
    return makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "unsupported" });
  }
  if (response.status === 401) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: REJECTED_KEY_MESSAGE,
    });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
  );
  const windows: ServerProviderUsageWindow[] = [
    {
      id: "go_rolling",
      kind: "session",
      label: "Go · Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(body.usage.rolling.percent),
      resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Go · Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(body.usage.weekly.percent),
      resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Go · Monthly",
      usedPercent: clampPercent(body.usage.monthly.percent),
      resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
    },
  ];
  const crypto = yield* Crypto.Crypto;
  // Go's usage response has no account ID. An unkeyed hash matches across
  // environments without a shared secret. It permits offline guesses, but
  // Go keys are randomly generated.
  const credentialFingerprint = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${input.apiKey}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
    credentialFingerprint,
  };
});

const resolveDataDirectory = Effect.fn("resolveOpenCodeDataDirectory")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const dataHome = environment.XDG_DATA_HOME?.trim();
  const root =
    dataHome && path.isAbsolute(dataHome)
      ? dataHome
      : path.join(
          environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
          ".local",
          "share",
        );
  return path.join(root, "opencode");
});

function envKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && key.length > 0 ? key : undefined;
}

const limitsForKey = (apiKey: string | undefined, checkedAt: string) =>
  apiKey === undefined
    ? Effect.succeed(makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }))
    : fetchGoUsage({ apiKey, checkedAt });

/**
 * External OpenCode servers own their credentials; never read the host's account for them.
 * OpenCode 2's key lives in the channel database, not in `auth.json`, which is imported once
 * and then left behind.
 */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (
  input: OpenCodeGoUsageInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  const read = Effect.gen(function* () {
    if (input.generation !== "v2") {
      const dataDirectory = yield* resolveDataDirectory(input.environment);
      return yield* limitsForKey(
        yield* readLegacyGoKey({ environment: input.environment, dataDirectory }),
        checkedAt,
      );
    }

    const filename = openCodeGoDatabaseFilename(input);
    if (filename === undefined) return unsupported;
    const dataDirectory = yield* resolveDataDirectory(input.environment);
    const path = yield* Path.Path;
    const databasePath = path.isAbsolute(filename) ? filename : path.join(dataDirectory, filename);
    const fs = yield* FileSystem.FileSystem;
    // Do not follow a link onto some other account's database.
    const linked = yield* fs
      .readLink(databasePath)
      .pipe(Effect.as(true), Effect.catchTags({ PlatformError: () => Effect.succeed(false) }));
    if (linked) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: UNREADABLE_MESSAGE,
      });
    }

    // A missing file is not a failure: a new official install still has auth.json.
    const present = yield* fs.exists(databasePath);
    const stored = present ? readStoredGoCredential(databasePath) : ({ _tag: "Missing" } as const);
    if (stored._tag === "Unread") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: UNREADABLE_MESSAGE,
      });
    }
    if (stored._tag === "Key") return yield* fetchGoUsage({ apiKey: stored.key, checkedAt });
    if (stored._tag === "Unusable") return unsupported;
    // The store exists and has no Go key. Official builds still honor
    // OPENCODE_API_KEY, which OpenCode uses when nothing is saved. A channel
    // build does not: a channel's own database can be empty, and the shared
    // auth.json key belongs to the official install.
    if (stored._tag === "Empty") {
      return yield* limitsForKey(
        isSharedDatabase(filename) ? envKey(input.environment.OPENCODE_API_KEY) : undefined,
        checkedAt,
      );
    }
    if (!isSharedDatabase(filename)) return unsupported;
    return yield* limitsForKey(
      yield* readLegacyGoKey({ environment: input.environment, dataDirectory }),
      checkedAt,
    );
  });

  return yield* read.pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: UNREADABLE_MESSAGE,
      }),
    ),
  );
});
