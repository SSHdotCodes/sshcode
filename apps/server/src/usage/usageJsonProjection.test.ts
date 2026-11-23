import { describe, expect, it } from "@effect/vitest";
import { projectUsageMetadata } from "./usageJsonProjection.ts";

const fields = {
  type: true,
  timestamp: true,
  payload: { type: true, role: true },
  uuid: true,
} as const;
describe("timing metadata projection", () => {
  it("reads only envelope fields through nested tool bodies, escaped quotes and structural characters", () => {
    const row = {
      timestamp: "2026-08-01T10:00:00Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: { nested: ['escaped \\" } ] {', { timestamp: "not a boundary" }] },
        role: "user",
      },
    };
    expect(projectUsageMetadata(Buffer.from(JSON.stringify(row)), fields)).toEqual({
      timestamp: row.timestamp,
      type: row.type,
      payload: { type: "function_call_output", role: "user" },
    });
  });
  it("matches native parsing for duplicate, escaped and reordered envelope keys", () => {
    const line =
      '{"payload":{"role":"assistant","type":"message"},"type":"wrong","ty\\u0070e":"response_item","ignored":[{"uuid":"fake"}],"uuid":"actual"}';
    expect(projectUsageMetadata(Buffer.from(line), fields)).toEqual({
      payload: { role: "assistant", type: "message" },
      type: "response_item",
      uuid: "actual",
    });
  });
  it.each([
    '{"type":"user","payload":{"x":[}',
    '{"type":"user"} junk',
    '{"type":"unterminated}',
    '{"type":"user",}',
  ])("rejects broken envelopes: %s", (text) => {
    expect(() => projectUsageMetadata(Buffer.from(text), fields)).toThrow();
  });
});
