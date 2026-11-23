import * as DateTime from "effect/DateTime";
import { type ClaudeRcItem, type ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { summarizeToolGroup } from "./work-log/presentation.ts";
import {
  TERMINAL_HOST_UPDATE_MESSAGE,
  composerTextAfterSend,
  filterTerminalSessions,
  terminalHostPhase,
  terminalListEnvironmentId,
  terminalSessionRelativeTime,
  terminalCommandFailure,
  terminalSessionRows,
  terminalToolDetails,
  terminalToolEntry,
} from "./terminalSessions.ts";

const primary = EnvironmentId.make("primary");
const other = EnvironmentId.make("other");
const hosts = [primary, other];

function session(id: string, title: string, updatedAt: string, working = false): ClaudeRcSession {
  return { id, title, updatedAt, working };
}

it("asks for an update and does not treat a missing config as unsupported", () => {
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: true,
      connecting: false,
      configLoaded: true,
      claudeRemoteControl: false,
    }),
  ).toEqual({ phase: "unsupported", message: TERMINAL_HOST_UPDATE_MESSAGE });
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: true,
      connecting: false,
      configLoaded: true,
      claudeRemoteControl: undefined,
    }).phase,
  ).toBe("unsupported");
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: true,
      connecting: false,
      configLoaded: false,
      claudeRemoteControl: undefined,
    }),
  ).toEqual({ phase: "loading", message: null });
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: true,
      connecting: false,
      configLoaded: true,
      claudeRemoteControl: true,
    }).phase,
  ).toBe("ready");
});

it("distinguishes a disconnected host from one that is reconnecting", () => {
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: false,
      connecting: false,
      configLoaded: true,
      claudeRemoteControl: true,
    }).phase,
  ).toBe("disconnected");
  expect(
    terminalHostPhase({
      environmentId: primary,
      connected: false,
      connecting: true,
      configLoaded: false,
      claudeRemoteControl: undefined,
    }).phase,
  ).toBe("reconnecting");
  expect(
    terminalHostPhase({
      environmentId: null,
      connected: false,
      connecting: false,
      configLoaded: false,
      claudeRemoteControl: undefined,
    }).phase,
  ).toBe("absent");
});

it("lists one known host, preferring a chosen machine and otherwise the primary", () => {
  expect(terminalListEnvironmentId(other, primary, hosts)).toBe(other);
  expect(terminalListEnvironmentId("all", primary, hosts)).toBe(primary);
  expect(terminalListEnvironmentId(null, primary, hosts)).toBe(primary);
  expect(terminalListEnvironmentId("all", EnvironmentId.make("gone"), hosts)).toBe(primary);
  expect(terminalListEnvironmentId("missing", primary, hosts)).toBeNull();
  expect(terminalListEnvironmentId(null, null, [])).toBeNull();
});

it("waits for this client's own machine and never lists another one as All meanwhile", () => {
  // After a restart a saved machine can load before the primary registers.
  expect(terminalListEnvironmentId("all", null, [other], true)).toBeNull();
  expect(terminalListEnvironmentId(null, null, [other], true)).toBeNull();
  // A machine the user chose is still shown, and a client with no machine of its own keeps the fallback.
  expect(terminalListEnvironmentId(other, null, [other], true)).toBe(other);
  expect(terminalListEnvironmentId("all", null, [other])).toBe(other);
  expect(
    terminalHostPhase({
      environmentId: null,
      connected: false,
      connecting: false,
      configLoaded: false,
      claudeRemoteControl: undefined,
      starting: true,
    }),
  ).toEqual({ phase: "loading", message: null });
  expect(
    terminalHostPhase({
      environmentId: null,
      connected: false,
      connecting: false,
      configLoaded: false,
      claudeRemoteControl: undefined,
    }).phase,
  ).toBe("absent");
});

it("filters titles locally and keeps one row for a session id", () => {
  const older = session("cse_old", "Login review", "2026-10-26T12:00:00.000Z");
  const working = session("cse_new", "Login notes", "2026-10-25T12:00:00.000Z", true);
  const duplicate = session("cse_new", "Login notes", "2026-10-27T12:00:00.000Z", false);
  expect(
    filterTerminalSessions([older, working, duplicate], "login").map((item) => item.id),
  ).toEqual(["cse_new", "cse_old"]);
  expect(filterTerminalSessions([older], "absent")).toEqual([]);
});

it("keeps a failed send and a newer draft typed while the send was in flight", () => {
  expect(composerTextAfterSend("hello", "hello", false)).toBe("hello");
  expect(composerTextAfterSend("hello", "hello", true)).toBe("");
  expect(composerTextAfterSend("hello there", "hello", true)).toBe("hello there");
});

it("formats relative times and ignores invalid timestamps", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  expect(terminalSessionRelativeTime("invalid", now)).toBe("");
  for (const [minutes, label] of [
    [-1, "just now"],
    [0, "just now"],
    [2, "2m ago"],
    [60, "1h ago"],
    [1440, "1d ago"],
  ] as const) {
    expect(
      terminalSessionRelativeTime(
        DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000)),
        now,
      ),
    ).toBe(label);
  }
});

it("uses a nonempty command error or the fallback", () => {
  expect(terminalCommandFailure(new Error("retry"), "failed")).toBe("retry");
  expect(terminalCommandFailure(new Error(" "), "failed")).toBe("failed");
  expect(terminalCommandFailure(null, "failed")).toBe("failed");
});

it("dedupes before filtering and sorts equal timestamps by id without changing the input", () => {
  const first = session("b", "Deploy", "2026-10-27T12:00:00.000Z");
  const second = session("a", "Deploy", first.updatedAt);
  const duplicate = { ...first, title: "Copy" };
  const input = [first, second, duplicate];
  expect(filterTerminalSessions(input, "copy")).toEqual([]);
  expect(filterTerminalSessions(input, " DEPLOY ")).toEqual([second, first]);
  expect(input).toEqual([first, second, duplicate]);
});

const call = (id: string, name: string, input: unknown, output?: string): ClaudeRcItem => ({
  id,
  role: "tool",
  text: "",
  tool: { name, input, ...(output === undefined ? {} : { output, done: true }) },
});

it("groups back-to-back tool calls and keeps messages apart", () => {
  const rows = terminalSessionRows([
    { id: "u", role: "user", text: "check it" },
    call("t1", "Bash", { command: "ls" }, "a"),
    call("t2", "Read", { file_path: "/Users/me/a.ts" }, "x"),
    { id: "a", role: "assistant", text: "done" },
    call("t3", "Bash", { command: "pwd" }),
  ]);
  expect(
    rows.map((row) => (row.kind === "tools" ? row.items.map((item) => item.id) : row.kind)),
  ).toEqual(["item", ["t1", "t2"], "item", ["t3"]]);
});

it("labels tool calls the way a chat's work log does", () => {
  const bash = terminalToolEntry(call("t1", "Bash", { command: "ls -la" }, "a"), false);
  expect(bash).toMatchObject({
    itemType: "command_execution",
    command: "ls -la",
    toolLifecycleStatus: "completed",
  });
  expect(summarizeToolGroup([bash, bash, bash]).summary).toBe("Ran 3 commands");
  expect(
    terminalToolEntry(call("t2", "Read", { file_path: "/Users/me/p/a.ts" }), true),
  ).toMatchObject({
    label: "Read ~/p/a.ts",
    toolLifecycleStatus: "inProgress",
  });
  expect(
    terminalToolEntry(call("t3", "Write", { file_path: "/home/me/b.ts", content: "x" }), false),
  ).toMatchObject({
    label: "Wrote ~/b.ts",
    changedFiles: ["~/b.ts"],
  });
  expect(
    terminalToolEntry(call("t4", "WebFetch", { url: "https://www.example.com/x" }), false).label,
  ).toBe("Fetched example.com");
  const failed: ClaudeRcItem = {
    ...call("t5", "Bash", { command: "false" }),
    tool: { name: "Bash", input: { command: "false" }, output: "exit 1", failed: true, done: true },
  };
  expect(terminalToolEntry(failed, false).toolLifecycleStatus).toBe("failed");
  const mcp: ClaudeRcItem = {
    id: "t6",
    role: "tool",
    text: "",
    tool: {
      name: "mcp__supabase__execute_sql",
      title: "execute sql",
      source: { key: "mcp:supabase", name: "Supabase", kind: "integration" },
      input: { query: "select 1" },
    },
  };
  expect(summarizeToolGroup([terminalToolEntry(mcp, false)]).summary).toBe(
    "Used Supabase integration",
  );
});

it("shows output, and the command when the label does not", () => {
  const item = call("t1", "Bash", { command: "curl -s https://x.test" }, "200");
  expect(terminalToolDetails(item, "curl -s https://x.test")).toBe("200");
  expect(terminalToolDetails(item, "Ran command")).toBe("curl -s https://x.test\n\n200");
  expect(terminalToolDetails(call("t2", "Read", { file_path: "/a" }, "body"), "Read /a")).toBe(
    "body",
  );
});

it("reads items from servers that sent calls and results separately", () => {
  expect(
    terminalToolEntry({ id: "old", role: "tool", text: 'Bash\n{"command":"ls"}' }, false),
  ).toMatchObject({ itemType: "command_execution", command: "ls" });
  expect(
    terminalToolEntry({ id: "out", role: "tool", text: "table before: 200" }, false),
  ).toMatchObject({
    toolTitle: "Tool output",
    toolData: { output: "table before: 200" },
  });
});
