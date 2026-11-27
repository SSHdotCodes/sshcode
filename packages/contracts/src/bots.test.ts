import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  botColor,
  botForThread,
  botsSettings,
  botThreadIds,
  DEFAULT_BOT_PERMISSIONS,
} from "./bots.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const bot = {
  id: "bot-1",
  name: "Pip",
  color: "teal",
  target: { instanceId: "codex", model: "gpt-6.1-sol" },
  threadId: "thread-bot",
  createdAt: "2026-11-26T12:00:00.000Z",
};

describe("botsSettings", () => {
  it("is off for settings files written before the field existed", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({});
    assert.deepStrictEqual(settings.bots, { enabled: false, list: [] });
    assert.deepStrictEqual(botsSettings(settings), { enabled: false, list: [], active: false });
    assert.deepStrictEqual(botsSettings(undefined), { enabled: false, list: [], active: false });
  });

  it("fills permission defaults and is active only when on with a bot", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({ bots: { list: [bot] } });
    assert.deepStrictEqual(settings.bots.list[0]?.permissions, DEFAULT_BOT_PERMISSIONS);
    const off = botsSettings(settings);
    assert.isFalse(off.active);
    assert.isUndefined(botForThread(off, "thread-bot"));
    // Turning Bots off must not turn a bot's home chat into an ordinary chat.
    assert.isTrue(botThreadIds(off).has("thread-bot"));

    const on = botsSettings({ bots: { ...settings.bots, enabled: true } });
    assert.isTrue(on.active);
    assert.strictEqual(botForThread(on, "thread-bot")?.name, "Pip");
    assert.isTrue(botThreadIds(on).has("thread-bot"));
    assert.isFalse(botsSettings({ bots: { enabled: true, list: [] } }).active);
  });

  it("reads an unknown color as the first palette color", () => {
    assert.strictEqual(botColor("teal"), "teal");
    assert.strictEqual(botColor("chartreuse"), "blue");
    assert.strictEqual(botColor(undefined), "blue");
  });

  it("accepts a switch-only patch", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ bots: { enabled: true } }),
      { bots: { enabled: true } },
    );
  });
});
