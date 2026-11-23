import { describe, expect, it } from "@effect/vitest";

import { CHAT_ID_ENV } from "./agentScope.ts";
import { chatCpu, parseChatIds, parseProcessTable, processesToRead } from "./busyChats.ts";

const table = (...rows: ReadonlyArray<readonly [number, number, number]>) =>
  rows.map(([pid, ppid, cpu]) => `  ${pid}  ${ppid}  ${cpu.toFixed(1)}`).join("\n");

describe("busy chats", () => {
  it("reads the process table and skips lines it cannot parse", () => {
    expect(parseProcessTable(`${table([10, 1, 2.5])}\n\n  garbage\n`)).toEqual([
      { pid: 10, ppid: 1, cpuPercent: 2.5 },
    ]);
  });

  it("takes the chat id from the environment, not from an argument that mentions it", () => {
    const stdout = [
      `  20 /opt/claude --resume x PATH=/bin ${CHAT_ID_ENV}=thread-a HOME=/u`,
      `  21 grep ${CHAT_ID_ENV}=thread-x PATH=/bin ${CHAT_ID_ENV}=thread-b`,
      `  22 /bin/sh -c make`,
    ].join("\n");
    expect([...parseChatIds(stdout)]).toEqual([
      [20, "thread-a"],
      [21, "thread-b"],
    ]);
  });

  it("counts a busy process for the nearest marked ancestor and hides small chats", () => {
    // 20 is chat a's agent. Its shell (30) hides its environment, but the
    // compiler under it (31) still counts for chat a. 40 is chat b's agent.
    const rows = parseProcessTable(
      table([20, 5, 12], [30, 20, 0.5], [31, 30, 180], [40, 5, 60], [50, 1, 300]),
    );
    expect(processesToRead(rows).toSorted((left, right) => left - right)).toEqual([
      5, 20, 30, 31, 40, 50,
    ]);
    const ids = new Map([
      [20, "thread-a"],
      [40, "thread-b"],
    ]);
    expect(chatCpu(rows, ids)).toEqual([{ threadId: "thread-a", cpuPercent: 190 }]);
  });

  it("survives a loop in the parent links", () => {
    const rows = parseProcessTable(table([60, 61, 150], [61, 60, 150]));
    expect(processesToRead(rows)).toEqual([60, 61]);
    expect(chatCpu(rows, new Map())).toEqual([]);
  });
});
