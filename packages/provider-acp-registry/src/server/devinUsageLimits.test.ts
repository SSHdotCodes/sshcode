// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the Node server with local fixtures.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  DEVIN_USAGE_PROBE_FAILED_MESSAGE,
  decodeDevinUserStatusPayload,
  devinUserStatusCacheToLimits,
  makeDevinUsageLimitsProbe,
  parseDevinUserStatusCache,
} from "./devinUsageLimits.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const devinSettings = decodeSettings({ agentId: "devin" });

function encodeVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let remaining = value < 0n ? BigInt.asUintN(64, value) : value;
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return bytes;
}

function encodeVarintField(fieldNumber: number, value: bigint | number): number[] {
  return [...encodeVarint(BigInt(fieldNumber << 3)), ...encodeVarint(BigInt(value))];
}

function encodeBytesField(
  fieldNumber: number,
  payload: ReadonlyArray<number> | Uint8Array,
): number[] {
  return [
    ...encodeVarint(BigInt((fieldNumber << 3) | 2)),
    ...encodeVarint(BigInt(payload.length)),
    ...payload,
  ];
}

function encodeFixed64Field(fieldNumber: number): number[] {
  return [...encodeVarint(BigInt((fieldNumber << 3) | 1)), 0, 0, 0, 0, 0, 0, 0, 0];
}

function encodeFixed32Field(fieldNumber: number): number[] {
  return [...encodeVarint(BigInt((fieldNumber << 3) | 5)), 0, 0, 0, 0];
}

/**
 * Builds a scrubbed protobuf `UserStatus` payload matching Devin 3000.14.x's
 * wire layout (numbers and plan label only; no personal or org identifiers).
 */
function makeDevinUserStatusPayload(input: {
  readonly dailyRemainingPercent?: bigint | number;
  readonly weeklyRemainingPercent?: bigint | number;
  readonly dailyResetAtUnix?: bigint | number;
  readonly weeklyResetAtUnix?: bigint | number;
  readonly includePlanInfo?: boolean;
  readonly includeExtraWireTypes?: boolean;
}): Uint8Array {
  const planStatusBytes: number[] = [];
  if (input.includePlanInfo !== false) {
    const planName = Buffer.from("Max", "utf8");
    const planInfoBytes = [...encodeVarintField(1, 17), ...encodeBytesField(2, planName)];
    planStatusBytes.push(...encodeBytesField(1, planInfoBytes));
    // plan_start / plan_end Timestamp submessages and -1 sentinel flex credits.
    planStatusBytes.push(...encodeBytesField(2, encodeVarintField(1, 1795048350)));
    planStatusBytes.push(...encodeBytesField(3, encodeVarintField(1, 1797640350)));
    planStatusBytes.push(...encodeVarintField(8, -1n));
  }
  if (input.dailyRemainingPercent !== undefined) {
    planStatusBytes.push(...encodeVarintField(14, input.dailyRemainingPercent));
  }
  if (input.weeklyRemainingPercent !== undefined) {
    planStatusBytes.push(...encodeVarintField(15, input.weeklyRemainingPercent));
  }
  planStatusBytes.push(...encodeVarintField(16, 10_000_000));
  if (input.dailyResetAtUnix !== undefined) {
    planStatusBytes.push(...encodeVarintField(17, input.dailyResetAtUnix));
  }
  if (input.weeklyResetAtUnix !== undefined) {
    planStatusBytes.push(...encodeVarintField(18, input.weeklyResetAtUnix));
  }

  const userStatusBytes: number[] = [
    ...encodeVarintField(1, 1),
    ...encodeVarintField(10, 17),
    ...(input.includeExtraWireTypes ? [...encodeFixed64Field(20), ...encodeFixed32Field(21)] : []),
    ...encodeBytesField(13, planStatusBytes),
    ...encodeBytesField(32, encodeVarintField(5, 1)),
  ];
  return Uint8Array.from(userStatusBytes);
}

function makeDevinCacheEnvelope(input: {
  readonly fetchedAtSecs: number;
  readonly payload: Uint8Array;
  readonly version?: number;
}): string {
  return JSON.stringify({
    version: input.version ?? 1,
    identity_digest: "00000000000000000000000000000000",
    fetched_at_secs: input.fetchedAtSecs,
    payload: Buffer.from(input.payload).toString("base64"),
  });
}

function stubCatalog(
  overrides: Partial<AcpRegistrySupport.AcpRegistryCatalog["Service"]> = {},
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () =>
      Effect.succeed({
        status: "ready",
        agentId: "devin",
        version: "3000.14.30821",
        distribution: "binary",
      }),
    resolve: () => Effect.die("unused resolve"),
    maintenance: () => Effect.die("unused maintenance"),
    pruneManagedVersions: () => Effect.die("unused"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
    ...overrides,
  };
}

describe("Devin usage limits parser", () => {
  it("parses scrubbed real Devin Max daily and weekly quota windows", () => {
    const payload = makeDevinUserStatusPayload({
      dailyRemainingPercent: 100,
      weeklyRemainingPercent: 94,
      dailyResetAtUnix: 1795248000,
      weeklyResetAtUnix: 1795334400,
      includeExtraWireTypes: true,
    });
    const envelope = makeDevinCacheEnvelope({
      fetchedAtSecs: 1795232014,
      payload,
    });

    const parsed = parseDevinUserStatusCache(envelope);
    expect(parsed).toEqual({
      fetchedAtSecs: 1795232014,
      windows: [
        {
          id: "daily",
          kind: "session",
          label: "Daily",
          usedPercent: 0,
          windowDurationMins: 1440,
          resetsAt: "2026-11-21T08:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 6,
          windowDurationMins: 10080,
          resetsAt: "2026-11-22T08:00:00.000Z",
        },
      ],
    });

    const limits = devinUserStatusCacheToLimits(parsed!, 1795232050_000);
    expect(limits).toEqual({
      checkedAt: "2026-11-21T03:33:34.000Z",
      windows: [
        {
          id: "daily",
          kind: "session",
          label: "Daily",
          usedPercent: 0,
          windowDurationMins: 1440,
          resetsAt: "2026-11-21T08:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 6,
          windowDurationMins: 10080,
          resetsAt: "2026-11-22T08:00:00.000Z",
        },
      ],
    });
  });

  it("handles exhausted quotas when proto3 omits zero remaining percent beside a reset timestamp", () => {
    const payload = makeDevinUserStatusPayload({
      // dailyRemainingPercent omitted (proto3 default 0 -> 100% used)
      dailyResetAtUnix: 1795248000,
      weeklyRemainingPercent: 0,
      weeklyResetAtUnix: 1795334400,
    });
    const decoded = decodeDevinUserStatusPayload(payload);
    expect(decoded?.windows).toEqual([
      {
        id: "daily",
        kind: "session",
        label: "Daily",
        usedPercent: 100,
        windowDurationMins: 1440,
        resetsAt: "2026-11-21T08:00:00.000Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-11-22T08:00:00.000Z",
      },
    ]);
  });

  it("ignores negative sentinel remaining percentages and supports single-window plans", () => {
    const payload = makeDevinUserStatusPayload({
      dailyRemainingPercent: -1n,
      weeklyRemainingPercent: 72,
      weeklyResetAtUnix: 1795334400,
    });
    const decoded = decodeDevinUserStatusPayload(payload);
    expect(decoded?.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 28,
        windowDurationMins: 10080,
        resetsAt: "2026-11-22T08:00:00.000Z",
      },
    ]);
  });

  it("merges split plan_status fields and clamps future fetchedAt to nowMs", () => {
    const part1 = encodeBytesField(13, [
      ...encodeVarintField(14, 40),
      ...encodeVarintField(17, 1795248000),
    ]);
    const part2 = encodeBytesField(13, [
      ...encodeVarintField(15, 85),
      ...encodeVarintField(18, 1795334400),
    ]);
    const payload = Uint8Array.from([...part1, ...part2]);
    const parsed = parseDevinUserStatusCache(
      makeDevinCacheEnvelope({ fetchedAtSecs: 1795232500, payload }),
    );
    expect(parsed?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Daily", 60],
      ["Weekly", 15],
    ]);
    const limits = devinUserStatusCacheToLimits(parsed!, 1795232000_000);
    expect(limits.checkedAt).toBe("2026-11-21T03:33:20.000Z");
  });

  it("rejects malformed envelopes, wrong versions, corrupt base64, and payloads without quotas", () => {
    const validPayload = makeDevinUserStatusPayload({
      dailyRemainingPercent: 80,
      weeklyRemainingPercent: 90,
    });
    expect(parseDevinUserStatusCache("not json")).toBeUndefined();
    expect(
      parseDevinUserStatusCache(
        makeDevinCacheEnvelope({ version: 2, fetchedAtSecs: 1795232014, payload: validPayload }),
      ),
    ).toBeUndefined();
    expect(
      parseDevinUserStatusCache(
        makeDevinCacheEnvelope({ fetchedAtSecs: 0, payload: validPayload }),
      ),
    ).toBeUndefined();
    expect(
      parseDevinUserStatusCache(
        JSON.stringify({ version: 1, fetched_at_secs: 1795232014, payload: "!!!not-base64!!!" }),
      ),
    ).toBeUndefined();
    expect(decodeDevinUserStatusPayload(Uint8Array.from([0xff, 0xff]))).toBeUndefined();
    // Invalid wire type 3 (deprecated group start).
    expect(decodeDevinUserStatusPayload(Uint8Array.from([(1 << 3) | 3]))).toBeUndefined();
    // Valid protobuf with no plan_status or no quota fields.
    expect(decodeDevinUserStatusPayload(Uint8Array.from(encodeVarintField(1, 1)))).toBeUndefined();
    expect(decodeDevinUserStatusPayload(makeDevinUserStatusPayload({}))).toBeUndefined();
  });
});

const ProbeTestLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe("makeDevinUsageLimitsProbe", () => {
  it.effect(
    "reads a fresh disk cache without refreshing, picks the newest valid file, and throttles to once a minute",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "devin-usage-cache-" });
        const cliCacheDir = path.join(cacheRoot, "devin", "cli");
        yield* fs.makeDirectory(cliCacheDir, { recursive: true });

        const nowSecs = 1795232020;
        yield* TestClock.setTime(nowSecs * 1000);

        // Older valid file + corrupt file + newest valid file.
        yield* fs.writeFileString(
          path.join(cliCacheDir, "user_status.older001.bin"),
          makeDevinCacheEnvelope({
            fetchedAtSecs: nowSecs - 40,
            payload: makeDevinUserStatusPayload({
              dailyRemainingPercent: 90,
              weeklyRemainingPercent: 95,
              dailyResetAtUnix: 1795248000,
              weeklyResetAtUnix: 1795334400,
            }),
          }),
        );
        yield* fs.writeFileString(path.join(cliCacheDir, "user_status.corrupt.bin"), "{bad");
        yield* fs.writeFileString(
          path.join(cliCacheDir, "user_status.newest02.bin"),
          makeDevinCacheEnvelope({
            fetchedAtSecs: nowSecs - 10,
            payload: makeDevinUserStatusPayload({
              dailyRemainingPercent: 75,
              weeklyRemainingPercent: 88,
              dailyResetAtUnix: 1795248000,
              weeklyResetAtUnix: 1795334400,
            }),
          }),
        );

        let refreshCalls = 0;
        const probe = yield* makeDevinUsageLimitsProbe({
          settings: devinSettings,
          cwd: cacheRoot,
          environment: { XDG_CACHE_HOME: cacheRoot },
          refreshCache: () =>
            Effect.sync(() => {
              refreshCalls += 1;
              return undefined;
            }),
        }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, stubCatalog()));

        const first = yield* probe.probe;
        expect(refreshCalls).toBe(0);
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toEqual([
          {
            id: "daily",
            kind: "session",
            label: "Daily",
            usedPercent: 25,
            windowDurationMins: 1440,
            resetsAt: "2026-11-21T08:00:00.000Z",
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 12,
            windowDurationMins: 10080,
            resetsAt: "2026-11-22T08:00:00.000Z",
          },
        ]);

        // Write a newer reading to disk and probe again 30 seconds later: throttled.
        yield* TestClock.adjust("30 seconds");
        yield* fs.writeFileString(
          path.join(cliCacheDir, "user_status.newest02.bin"),
          makeDevinCacheEnvelope({
            fetchedAtSecs: nowSecs + 25,
            payload: makeDevinUserStatusPayload({
              dailyRemainingPercent: 50,
              weeklyRemainingPercent: 80,
              dailyResetAtUnix: 1795248000,
              weeklyResetAtUnix: 1795334400,
            }),
          }),
        );
        const throttled = yield* probe.probe;
        expect(throttled.windows[0]?.usedPercent).toBe(25);
        expect(refreshCalls).toBe(0);

        // After a full minute, the probe reads the updated file.
        yield* TestClock.adjust("30 seconds");
        const second = yield* probe.probe;
        expect(second.windows[0]?.usedPercent).toBe(50);
        expect(second.windows[1]?.usedPercent).toBe(20);
        expect(refreshCalls).toBe(0);
      }).pipe(Effect.provide(ProbeTestLayer)),
  );

  it.effect(
    "refreshes when the disk cache is stale and reports probeFailed with notice on failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "devin-usage-stale-" });
        const cliCacheDir = path.join(cacheRoot, "devin", "cli");
        yield* fs.makeDirectory(cliCacheDir, { recursive: true });

        const nowSecs = 1795232020;
        yield* TestClock.setTime(nowSecs * 1000);

        // Stale cache (10 minutes old).
        yield* fs.writeFileString(
          path.join(cliCacheDir, "user_status.stale001.bin"),
          makeDevinCacheEnvelope({
            fetchedAtSecs: nowSecs - 600,
            payload: makeDevinUserStatusPayload({
              dailyRemainingPercent: 99,
              weeklyRemainingPercent: 99,
              dailyResetAtUnix: 1795248000,
              weeklyResetAtUnix: 1795334400,
            }),
          }),
        );

        let refreshCalls = 0;
        let shouldSucceed = false;
        const probe = yield* makeDevinUsageLimitsProbe({
          settings: devinSettings,
          cwd: cacheRoot,
          environment: { XDG_CACHE_HOME: cacheRoot },
          refreshCache: () =>
            Effect.sync(() => {
              refreshCalls += 1;
              if (!shouldSucceed) return undefined;
              return {
                fetchedAtSecs: nowSecs + 60,
                windows: [
                  {
                    id: "daily",
                    kind: "session",
                    label: "Daily",
                    usedPercent: 18,
                    windowDurationMins: 1440,
                    resetsAt: "2026-11-21T08:00:00.000Z",
                  },
                  {
                    id: "weekly",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 9,
                    windowDurationMins: 10080,
                    resetsAt: "2026-11-22T08:00:00.000Z",
                  },
                ],
              };
            }),
        }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, stubCatalog()));

        const failed = yield* probe.probe;
        expect(refreshCalls).toBe(1);
        expect(failed.windows).toEqual([]);
        expect(failed.unavailable).toEqual({
          reason: "probeFailed",
          message: DEVIN_USAGE_PROBE_FAILED_MESSAGE,
        });

        // Failure is also throttled for 60s until cleared or 1 minute elapses.
        shouldSucceed = true;
        const stillThrottled = yield* probe.probe;
        expect(refreshCalls).toBe(1);
        expect(stillThrottled.unavailable?.reason).toBe("probeFailed");

        yield* probe.clear;
        yield* TestClock.adjust("1 minute");
        const recovered = yield* probe.probe;
        expect(refreshCalls).toBe(2);
        expect(recovered.unavailable).toBeUndefined();
        expect(recovered.windows.map((w) => [w.label, w.usedPercent])).toEqual([
          ["Daily", 18],
          ["Weekly", 9],
        ]);
      }).pipe(Effect.provide(ProbeTestLayer)),
  );

  it.live("refreshes through ACP initialize without starting a session or model turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-acp-init-probe-" });
      const cliCacheDir = path.join(tempDir, "devin", "cli");
      const agentPath = path.join(tempDir, "fake-devin.mjs");
      const methodsLogPath = path.join(tempDir, "methods.log");
      const nowSecs = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const envelope = makeDevinCacheEnvelope({
        fetchedAtSecs: nowSecs,
        payload: makeDevinUserStatusPayload({
          dailyRemainingPercent: 82,
          weeklyRemainingPercent: 91,
          dailyResetAtUnix: 1795248000,
          weeklyResetAtUnix: 1795334400,
        }),
      });
      yield* fs.writeFileString(
        agentPath,
        [
          `import * as fs from "node:fs";`,
          `import * as path from "node:path";`,
          `import * as readline from "node:readline";`,
          `const cacheDir = ${JSON.stringify(cliCacheDir)};`,
          `const methodsLogPath = ${JSON.stringify(methodsLogPath)};`,
          `const envelope = ${JSON.stringify(envelope)};`,
          `const rl = readline.createInterface({ input: process.stdin });`,
          `rl.on("line", (line) => {`,
          `  if (!line.trim()) return;`,
          `  const msg = JSON.parse(line);`,
          `  fs.appendFileSync(methodsLogPath, msg.method + "\\n");`,
          `  if (msg.method === "initialize") {`,
          `    process.stdout.write(JSON.stringify({`,
          `      jsonrpc: "2.0",`,
          `      id: msg.id,`,
          `      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },`,
          `    }) + "\\n");`,
          `    setTimeout(() => {`,
          `      fs.mkdirSync(cacheDir, { recursive: true });`,
          `      fs.writeFileSync(path.join(cacheDir, "user_status.fake1234.bin"), envelope);`,
          `    }, 40);`,
          `  }`,
          `});`,
        ].join("\n"),
      );

      const probe = yield* makeDevinUsageLimitsProbe({
        settings: devinSettings,
        cwd: tempDir,
        environment: { XDG_CACHE_HOME: tempDir },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          stubCatalog({
            resolve: () =>
              Effect.succeed({
                distribution: "local" as const,
                spawn: { command: process.execPath, args: [agentPath] },
              }),
          }),
        ),
      );

      const limits = yield* probe.probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toEqual([
        {
          id: "daily",
          kind: "session",
          label: "Daily",
          usedPercent: 18,
          windowDurationMins: 1440,
          resetsAt: "2026-11-21T08:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 9,
          windowDurationMins: 10080,
          resetsAt: "2026-11-22T08:00:00.000Z",
        },
      ]);
      const methods = (yield* fs.readFileString(methodsLogPath)).trim().split("\n");
      expect(methods).toEqual(["initialize"]);
    }).pipe(Effect.provide(ProbeTestLayer)),
  );
});
