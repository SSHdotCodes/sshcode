import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { makeUsageLimitRecorder, readUsageLimitRecordings } from "./usageLimitRecorder.ts";

const HOUR = 3_600_000;
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex_personal");
const reading = (hour: number) => ({
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(hour * HOUR)),
  credentialFingerprint: "private-credential-identity",
  windows: [
    {
      id: "weekly",
      label: "private-account-name",
      kind: "weekly" as const,
      usedPercent: hour,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(7 * 24 * HOUR)),
    },
  ],
});

it.layer(NodeServices.layer)("usage limit recorder", (it) => {
  it.effect("keeps readings across recorder restarts without recording account identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(0);
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const first = yield* makeUsageLimitRecorder({ filePath });
      yield* first.append(instanceId, driver, reading(0));
      const restarted = yield* makeUsageLimitRecorder({ filePath });
      yield* restarted.append(instanceId, driver, reading(0));
      yield* TestClock.setTime(HOUR);
      yield* restarted.append(instanceId, driver, reading(1));
      const raw = yield* fs.readFileString(filePath);
      const saved = readUsageLimitRecordings(raw);
      assert.strictEqual(saved.length, 2);
      assert.deepStrictEqual(
        saved.map((row) => row.usedPercent),
        [0, 1],
      );
      assert.strictEqual(saved[0]?.instanceId, saved[1]?.instanceId);
      assert.ok(!raw.includes(instanceId));
      assert.ok(!raw.includes("private-"));
      assert.ok(!raw.includes("credentialFingerprint"));
      assert.strictEqual(saved[1]?.driver, driver);
      assert.strictEqual(saved[1]?.windowId, "weekly");
    }),
  );

  it.effect("drops the oldest readings before the file exceeds its byte cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(0);
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath, maxBytes: 1600 });
      for (let hour = 0; hour < 30; hour++) {
        yield* TestClock.setTime(hour * HOUR);
        yield* recorder.append(instanceId, driver, reading(hour));
        assert.ok(Number((yield* fs.stat(filePath)).size) <= 1600);
      }
      const rows = readUsageLimitRecordings(yield* fs.readFileString(filePath));
      assert.ok(rows.length > 1);
      assert.ok(rows[0]!.usedPercent > 0);
      assert.strictEqual(rows.at(-1)?.usedPercent, 29);
      assert.deepStrictEqual(
        rows.map((row) => row.usedPercent),
        Array.from({ length: rows.length }, (_, index) => 30 - rows.length + index),
      );
    }),
  );

  it.effect("expires readings after 28 days, including on restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(0);
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath });
      yield* recorder.append(instanceId, driver, reading(0));
      yield* TestClock.setTime(28 * 24 * HOUR + 1);
      yield* makeUsageLimitRecorder({ filePath });
      assert.deepStrictEqual(readUsageLimitRecordings(yield* fs.readFileString(filePath)), []);
    }),
  );

  it.effect(
    "ignores repeated snapshots and failed probes, but records unchanged fresh readings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* TestClock.setTime(0);
        const dir = yield* fs.makeTempDirectoryScoped();
        const filePath = `${dir}/readings.ndjson`;
        const recorder = yield* makeUsageLimitRecorder({ filePath });
        yield* recorder.append(instanceId, driver, reading(0));
        yield* recorder.append(instanceId, driver, reading(0));
        yield* recorder.append(instanceId, driver, {
          ...reading(1),
          unavailable: { reason: "probeFailed" },
        });
        yield* TestClock.setTime(HOUR);
        yield* recorder.append(instanceId, driver, { ...reading(1), windows: reading(0).windows });
        assert.strictEqual(readUsageLimitRecordings(yield* fs.readFileString(filePath)).length, 2);
      }),
  );

  it.effect("writes an unmoved counter again only every half hour, a moved one at once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(0);
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath });
      const at = (minute: number, usedPercent: number, resetShiftSeconds = 0) => ({
        ...reading(0),
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(minute * 60_000)),
        windows: [
          {
            ...reading(0).windows[0]!,
            usedPercent,
            resetsAt: DateTime.formatIso(
              DateTime.makeUnsafe(7 * 24 * HOUR + resetShiftSeconds * 1000),
            ),
          },
        ],
      });
      const saved = Effect.map(fs.readFileString(filePath), (raw) =>
        readUsageLimitRecordings(raw).map((row) => Date.parse(row.checkedAt) / 60_000),
      );
      yield* recorder.append(instanceId, driver, at(0, 4));
      for (const minute of [5, 10, 15, 20, 25]) {
        yield* TestClock.setTime(minute * 60_000);
        // Rolling resets move by seconds between checks; that is not a new period.
        yield* recorder.append(instanceId, driver, at(minute, 4, minute));
      }
      assert.deepStrictEqual(yield* saved, [0]);
      yield* TestClock.setTime(30 * 60_000);
      yield* recorder.append(instanceId, driver, at(30, 4));
      yield* TestClock.setTime(35 * 60_000);
      yield* recorder.append(instanceId, driver, at(35, 5));
      yield* TestClock.setTime(40 * 60_000);
      yield* recorder.append(instanceId, driver, at(40, 5, 3600));
      // A restart must not write the unmoved counter again either.
      const restarted = yield* makeUsageLimitRecorder({ filePath });
      yield* TestClock.setTime(45 * 60_000);
      yield* restarted.append(instanceId, driver, at(45, 5, 3600));
      assert.deepStrictEqual(yield* saved, [0, 30, 35, 40]);
    }),
  );

  it.effect("repairs an incomplete final append before the next reading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(0);
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath });
      yield* recorder.append(instanceId, driver, reading(0));
      yield* fs.writeFileString(filePath, '{"incomplete":', { flag: "a" });
      const restarted = yield* makeUsageLimitRecorder({ filePath });
      yield* TestClock.setTime(HOUR);
      yield* restarted.append(instanceId, driver, reading(1));
      assert.strictEqual(readUsageLimitRecordings(yield* fs.readFileString(filePath)).length, 2);
    }),
  );

  it.effect("keeps the newest complete readings when a restart reduces the cap", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath });
      for (let hour = 0; hour < 12; hour++)
        yield* recorder.append(instanceId, driver, reading(hour));
      yield* makeUsageLimitRecorder({ filePath, maxBytes: 1000 });
      const raw = yield* fs.readFileString(filePath);
      const rows = readUsageLimitRecordings(raw);
      assert.ok(Buffer.byteLength(raw) <= 1000);
      assert.ok(rows.length > 0);
      assert.ok(rows[0]!.usedPercent > 0);
      assert.strictEqual(rows.at(-1)?.usedPercent, 11);
    }),
  );

  it.effect("drops oldest by reading time when concurrent sources arrive out of order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/readings.ndjson`;
      const recorder = yield* makeUsageLimitRecorder({ filePath, maxBytes: 700 });
      for (const hour of [8, 9, 10, 0]) yield* recorder.append(instanceId, driver, reading(hour));
      const rows = readUsageLimitRecordings(yield* fs.readFileString(filePath));
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.usedPercent >= 8));
      yield* recorder.append(instanceId, driver, {
        ...reading(11),
        credentialFingerprint: "different-private-account",
      });
      const changed = readUsageLimitRecordings(yield* fs.readFileString(filePath));
      assert.notStrictEqual(changed.at(-1)?.instanceId, rows.at(-1)?.instanceId);
    }),
  );
});
