import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult, NativeSessionDiscoverInput } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

it("bounds native session queries and page sizes without accepting filesystem selectors", () => {
  const decode = Schema.decodeUnknownOption(NativeSessionDiscoverInput);
  expect(Option.isNone(decode({ query: "x".repeat(501) }))).toBe(true);
  expect(Option.isNone(decode({ limit: 51 }))).toBe(true);
  expect(Option.isNone(decode({ limit: 0 }))).toBe(true);
  expect(Option.isSome(decode({ query: "/workspace", limit: 30, cursor: "opaque" }))).toBe(true);
});
