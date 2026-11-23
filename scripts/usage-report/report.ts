// @effect-diagnostics globalDate:off - Calendar calculations on explicit timestamps, not the current clock.
// Pure computation of the usage report from thread and run rows. No I/O.

export interface ThreadRow {
  thread_id: string;
  title: string | null;
  created_at: string | null;
  payload_json: string | null;
}

export interface RunRow {
  run_id: string;
  thread_id: string;
  status: string | null;
  requested_at: string | null;
  completed_at: string | null;
  payload_json: string | null;
}

export interface ReportOptions {
  until: number; // epoch ms
  days: number;
  top: number;
}

export interface LeadModelRow {
  model: string;
  runs: number;
  chats: number;
  completed: number;
  failed: number;
  stopped: number;
  hours: number;
}

export interface SubagentModelRow {
  model: string;
  tasks: number;
  medianMinutes: number;
  under3: number;
  from3to20: number;
  from20to60: number;
  over60: number;
  followUpsPerTask: number;
  hours: number;
}

export interface ChatRow {
  threadId: string;
  title: string;
  leadModel: string;
  turns: number;
  leadHours: number;
  subagentTasks: number;
  subagentHours: number;
  concurrency: number;
}

export interface DayRow {
  day: string;
  subagentTasks: number;
  reviews: number;
}

export interface Report {
  window: { days: number; since: string; until: string };
  totals: {
    leadChats: number;
    leadChatsWithSubagents: number;
    leadHours: number;
    subagentTasks: number;
    subagentHours: number;
  };
  leadModels: LeadModelRow[];
  subagentModels: SubagentModelRow[];
  chats: ChatRow[];
  days: DayRow[];
}

export const SUBAGENT_PREFIX = "thread:delegated-task:";
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Parses an ISO 8601 time to epoch ms. A time without an offset is UTC. Returns null when invalid. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const base = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (new Date(base).getUTCDate() !== day) return null;
  let offset = 0;
  const zone = m[8];
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 23 || om > 59) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om) * MINUTE_MS;
  }
  return base - offset;
}

/** Parses payload JSON, treating anything that is not a JSON object as `{}`. */
export function parsePayload(json: string | null | undefined): Record<string, unknown> {
  if (typeof json !== "string" || json === "") return {};
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Rounds like Python's round(x, digits): correctly rounded on the exact binary value,
 * with exact ties going to the even digit.
 */
export function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const fixed = x.toFixed(digits);
  const exact = x.toFixed(Math.min(100, digits + 60));
  const tail = exact.slice(exact.indexOf(".") + 1 + digits);
  if (/^50*$/.test(tail)) {
    // Exact tie: toFixed rounded away from zero; step back when that digit is odd.
    const lastDigit = Number(fixed[fixed.length - 1]);
    if (lastDigit % 2 === 1)
      return Number((Number(fixed) - Math.sign(x) * 10 ** -digits).toFixed(digits));
  }
  return Number(fixed);
}

export function isReviewTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    t.startsWith("review") || t.slice(0, 40).includes(" review") || t.slice(0, 30).includes("audit")
  );
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Minutes covered by the union of [start, end] intervals given in epoch ms. */
export function unionMinutes(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      covered += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  covered += curEnd - curStart;
  return covered / MINUTE_MS;
}

interface Run {
  runId: string;
  requestedAt: number;
  status: string | null;
  model: string;
  minutes: number;
  interval: [number, number] | null;
}

interface Thread {
  threadId: string;
  title: string;
  isSubagent: boolean;
  root: string | null;
  createdAt: number | null;
}

/** Most frequent model; ties go to the model of the latest run (requested_at, then run_id). */
export function mostFrequentModel(runs: Run[]): string {
  const counts = new Map<string, number>();
  let best = 0;
  for (const run of runs) {
    const n = (counts.get(run.model) ?? 0) + 1;
    counts.set(run.model, n);
    if (n > best) best = n;
  }
  let winner: Run | null = null;
  for (const run of runs) {
    if (counts.get(run.model) !== best) continue;
    if (
      winner === null ||
      run.requestedAt > winner.requestedAt ||
      (run.requestedAt === winner.requestedAt && run.runId > winner.runId)
    ) {
      winner = run;
    }
  }
  return winner === null ? "unknown" : winner.model;
}

function toThread(row: ThreadRow): Thread {
  const payload = parsePayload(row.payload_json);
  const lineage = payload.lineage;
  const isSubagent =
    field(lineage, "relationshipToParent") === "subagent" ||
    row.thread_id.startsWith(SUBAGENT_PREFIX);
  return {
    threadId: row.thread_id,
    title: row.title ?? "",
    isSubagent,
    root: isSubagent
      ? (nonEmptyString(field(lineage, "rootThreadId")) ??
        nonEmptyString(field(lineage, "parentThreadId")))
      : null,
    createdAt: parseTime(payload.createdAt) ?? parseTime(row.created_at),
  };
}

function toRun(row: RunRow, requestedAt: number): Run {
  const payload = parsePayload(row.payload_json);
  const model = nonEmptyString(field(payload.modelSelection, "model")) ?? "unknown";
  const started = parseTime(payload.startedAt);
  const completed = parseTime(row.completed_at);
  let minutes = 0;
  let interval: [number, number] | null = null;
  if (started !== null && completed !== null && completed >= started) {
    minutes = (completed - started) / MINUTE_MS;
    if (minutes > 0) interval = [started, completed];
  }
  return { runId: row.run_id, requestedAt, status: row.status, model, minutes, interval };
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day in America/New_York as YYYY-MM-DD. */
export function newYorkDay(ms: number): string {
  let y = "";
  let m = "";
  let d = "";
  for (const part of dayFormatter.formatToParts(ms)) {
    if (part.type === "year") y = part.value;
    else if (part.type === "month") m = part.value;
    else if (part.type === "day") d = part.value;
  }
  return `${y}-${m}-${d}`;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);

export function buildReport(
  threadRows: ThreadRow[],
  runRows: RunRow[],
  options: ReportOptions,
): Report {
  const until = options.until;
  const since = until - options.days * 24 * HOUR_MS;

  const threads = new Map<string, Thread>();
  for (const row of threadRows) threads.set(row.thread_id, toThread(row));

  // Runs in the window, grouped by thread.
  const runsByThread = new Map<string, Run[]>();
  for (const row of runRows) {
    const requestedAt = parseTime(row.requested_at);
    if (requestedAt === null || requestedAt < since || requestedAt > until) continue;
    const list = runsByThread.get(row.thread_id);
    const run = toRun(row, requestedAt);
    if (list) list.push(run);
    else runsByThread.set(row.thread_id, [run]);
  }

  const threadFor = (threadId: string): Thread =>
    threads.get(threadId) ?? {
      threadId,
      title: "",
      isSubagent: threadId.startsWith(SUBAGENT_PREFIX),
      root: null,
      createdAt: null,
    };

  interface Task {
    thread: Thread;
    runs: Run[];
    minutes: number;
    model: string;
  }
  const leadChats: Array<{ thread: Thread; runs: Run[] }> = [];
  const tasks: Task[] = [];
  for (const [threadId, runs] of runsByThread) {
    const thread = threadFor(threadId);
    if (thread.isSubagent) {
      tasks.push({
        thread,
        runs,
        minutes: sum(runs.map((r) => r.minutes)),
        model: mostFrequentModel(runs),
      });
    } else {
      leadChats.push({ thread, runs });
    }
  }

  // Lead models.
  const leadModelMap = new Map<
    string,
    {
      runs: number;
      chats: Set<string>;
      completed: number;
      failed: number;
      stopped: number;
      minutes: number;
    }
  >();
  for (const chat of leadChats) {
    for (const run of chat.runs) {
      let group = leadModelMap.get(run.model);
      if (!group) {
        group = { runs: 0, chats: new Set(), completed: 0, failed: 0, stopped: 0, minutes: 0 };
        leadModelMap.set(run.model, group);
      }
      group.runs++;
      group.chats.add(chat.thread.threadId);
      if (run.status === "completed") group.completed++;
      else if (run.status === "failed") group.failed++;
      else if (run.status === "cancelled" || run.status === "interrupted") group.stopped++;
      group.minutes += run.minutes;
    }
  }
  const leadModels: LeadModelRow[] = [...leadModelMap]
    .map(([model, g]) => ({
      model,
      runs: g.runs,
      chats: g.chats.size,
      completed: g.completed,
      failed: g.failed,
      stopped: g.stopped,
      hours: roundTo(g.minutes / 60, 1),
    }))
    .sort((a, b) => b.runs - a.runs || byString(a.model, b.model));

  // Subagent models.
  const taskModelMap = new Map<string, Task[]>();
  for (const task of tasks) {
    const list = taskModelMap.get(task.model);
    if (list) list.push(task);
    else taskModelMap.set(task.model, [task]);
  }
  const subagentModels: SubagentModelRow[] = [...taskModelMap]
    .map(([model, group]) => {
      const minutes = group.map((t) => t.minutes);
      const runCount = sum(group.map((t) => t.runs.length));
      return {
        model,
        tasks: group.length,
        medianMinutes: roundTo(median(minutes), 1),
        under3: minutes.filter((m) => m < 3).length,
        from3to20: minutes.filter((m) => m >= 3 && m < 20).length,
        from20to60: minutes.filter((m) => m >= 20 && m < 60).length,
        over60: minutes.filter((m) => m >= 60).length,
        followUpsPerTask: roundTo(runCount / group.length - 1, 1),
        hours: roundTo(sum(minutes) / 60, 1),
      };
    })
    .sort((a, b) => b.tasks - a.tasks || byString(a.model, b.model));

  // Chats.
  const tasksByRoot = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.thread.root === null) continue;
    const list = tasksByRoot.get(task.thread.root);
    if (list) list.push(task);
    else tasksByRoot.set(task.thread.root, [task]);
  }
  const chatStats = leadChats.map(({ thread, runs }) => {
    const rootTasks = tasksByRoot.get(thread.threadId) ?? [];
    const taskRuns = rootTasks.flatMap((t) => t.runs);
    const union = unionMinutes(taskRuns.flatMap((r) => (r.interval ? [r.interval] : [])));
    const taskMinutes = sum(taskRuns.map((r) => r.minutes));
    return {
      threadId: thread.threadId,
      title: thread.title,
      leadModel: mostFrequentModel(runs),
      turns: runs.length,
      leadMinutes: sum(runs.map((r) => r.minutes)),
      subagentTasks: rootTasks.length,
      subagentMinutes: taskMinutes,
      concurrency: union > 0 ? roundTo(taskMinutes / union, 2) : 0,
    };
  });
  const chats: ChatRow[] = [...chatStats]
    .sort((a, b) => b.leadMinutes - a.leadMinutes || byString(a.threadId, b.threadId))
    .slice(0, options.top)
    .map((c) => ({
      threadId: c.threadId,
      title: c.title,
      leadModel: c.leadModel,
      turns: c.turns,
      leadHours: roundTo(c.leadMinutes / 60, 1),
      subagentTasks: c.subagentTasks,
      subagentHours: roundTo(c.subagentMinutes / 60, 1),
      concurrency: c.concurrency,
    }));

  // Days.
  const dayMap = new Map<string, DayRow>();
  for (const task of tasks) {
    if (task.thread.createdAt === null) continue;
    const day = newYorkDay(task.thread.createdAt);
    let row = dayMap.get(day);
    if (!row) {
      row = { day, subagentTasks: 0, reviews: 0 };
      dayMap.set(day, row);
    }
    row.subagentTasks++;
    if (isReviewTitle(task.thread.title)) row.reviews++;
  }
  const days = [...dayMap.values()].sort((a, b) => byString(a.day, b.day));

  return {
    window: {
      days: options.days,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
    },
    totals: {
      leadChats: leadChats.length,
      leadChatsWithSubagents: chatStats.filter((c) => c.subagentTasks > 0).length,
      leadHours: roundTo(sum(chatStats.map((c) => c.leadMinutes)) / 60, 1),
      subagentTasks: tasks.length,
      subagentHours: roundTo(sum(tasks.map((t) => t.minutes)) / 60, 1),
    },
    leadModels,
    subagentModels,
    chats,
    days,
  };
}
