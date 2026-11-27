import { botAllowsSubagents } from "../bots/botsRuntime.ts";
/**
 * Per-chat long-running placement, activity days, the subagents switch, and
 * the ask on a chat's first subagent. Saved in chat-controls.json in the state
 * dir. Shell rows read it in memory; the sidebar never scans a transcript.
 *
 * Distinct days are filled once from runs and user-authored messages. Later
 * activity only records instants newer than the stored last-active time.
 */
import {
  currentAgentBehavior,
  SubagentsEnabled,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  ChatControlsError,
  type ChatControlsCommand,
  type FirstSubagentVerdict,
} from "@t3tools/contracts";
import { localCalendarDay, type LongRunningOverride } from "@t3tools/shared/chatControls";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { announceBoxChange } from "./boxNamerCache.ts";

const CONTROLS_FILE = "chat-controls.json";
/** An unanswered ask counts as "Fine" after this long, so it never lingers on a card. */
export const FIRST_SUBAGENT_ASK_MS = 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

interface ChatControlRecord {
  override: LongRunningOverride | null;
  readonly days: Set<string>;
  lastActiveAt: string | null;
  subagents: boolean;
  notice: boolean;
  /** The first app-owned subagent's id while it runs unanswered, for at most a minute. */
  ask: string | null;
  /** The user answered the ask, or it timed out as "Fine"; this chat never asks again. */
  answered: boolean;
}

export interface ChatControlView {
  readonly override: LongRunningOverride | null;
  readonly dayCount: number;
  readonly lastActiveAt: string | null;
  readonly subagentsEnabled: boolean;
  /** Present only while the switch is on, so turning it off hides the ask too. */
  readonly firstSubagentAsk: string | null;
}

export class ChatControls extends Context.Service<ChatControls, ReturnType<typeof make>["store"]>()(
  "t3/sessionBoxes/chatControls",
) {}

export function make(
  options: {
    /** Runs `keepFine` once the ask's minute is over. Tests pass their own. */
    readonly afterAskDelay?: (keepFine: () => void) => void;
  } = {},
) {
  const afterAskDelay =
    options.afterAskDelay ??
    ((keepFine: () => void) => {
      // @effect-diagnostics-next-line globalTimers:off - a plain store with no fiber to sleep on.
      setTimeout(keepFine, FIRST_SUBAGENT_ASK_MS).unref();
    });
  const threads = new Map<string, ChatControlRecord>();
  let onChange: (() => void) | null = null;
  let hydrated = false;
  /** True once past runs were scanned into `days`; the scan runs once per state dir. */
  let activityIndexed = false;
  /** Chats whose first subagent was looked up since startup; each is looked up once. */
  const firstSubagentChecked = new Set<string>();
  const subagentListeners = new Set<() => void>();
  // Settings > Agents "None" turns subagents off in every chat, as if each chat's own switch
  // were off; the chat keeps its own choice for when the level changes back. A live session
  // learns a flip the way it learns the chat's switch: one line on its next message. Flips
  // are counted when read; a session that saw an odd number fewer is out of date.
  let settingsOff: boolean | null = null;
  let settingsFlips = 0;
  /** Last effective `subagentsEnabled` state each chat's session observed in this process. */
  const seenEffective = new Map<string, boolean>();

  function emptyRecord(): ChatControlRecord {
    return {
      override: null,
      days: new Set(),
      lastActiveAt: null,
      subagents: true,
      notice: false,
      ask: null,
      answered: false,
    };
  }

  function viewOf(record: ChatControlRecord | undefined): ChatControlView {
    return {
      override: record?.override ?? null,
      dayCount: record?.days.size ?? 0,
      lastActiveAt: record?.lastActiveAt ?? null,
      subagentsEnabled: record?.subagents !== false,
      firstSubagentAsk: record?.subagents === false ? null : (record?.ask ?? null),
    };
  }

  function sameView(left: ChatControlView, right: ChatControlView): boolean {
    return (
      left.override === right.override &&
      left.dayCount === right.dayCount &&
      left.lastActiveAt === right.lastActiveAt &&
      left.subagentsEnabled === right.subagentsEnabled &&
      left.firstSubagentAsk === right.firstSubagentAsk
    );
  }

  function ensure(threadId: string): ChatControlRecord {
    const existing = threads.get(threadId);
    if (existing !== undefined) return existing;
    const created = emptyRecord();
    threads.set(threadId, created);
    return created;
  }

  function touch() {
    onChange?.();
  }

  function announce(threadIds: Iterable<string>) {
    for (const threadId of threadIds) announceBoxChange(threadId);
  }

  function subagentsOffInSettings(): boolean {
    const off = currentAgentBehavior().subagents === "none";
    if (settingsOff !== null && off !== settingsOff) settingsFlips += 1;
    settingsOff = off;
    return off;
  }

  function notifySubagents() {
    for (const listener of subagentListeners) listener();
  }

  function instantMs(value: string | null): number | null {
    if (value === null) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  /** Adds a day even when it is older than the stored last-active time. */
  function addActivity(record: ChatControlRecord, at: string): boolean {
    const ms = instantMs(at);
    if (ms === null) return false;
    const day = localCalendarDay(ms);
    let changed = false;
    if (!record.days.has(day)) {
      record.days.add(day);
      changed = true;
    }
    const previous = instantMs(record.lastActiveAt);
    if (previous === null || ms > previous) {
      record.lastActiveAt = at;
      changed = true;
    }
    return changed;
  }

  function rememberNewer(record: ChatControlRecord, at: string): boolean {
    const ms = instantMs(at);
    const previous = instantMs(record.lastActiveAt);
    if (ms === null || (previous !== null && ms <= previous)) return false;
    return addActivity(record, at);
  }

  const ThreadFile = Schema.Struct({
    override: Schema.optional(Schema.NullOr(Schema.Literals(["include", "exclude"]))),
    days: Schema.optional(Schema.Array(Schema.String)),
    lastActiveAt: Schema.optional(Schema.NullOr(Schema.String)),
    subagents: Schema.optional(Schema.Boolean),
    notice: Schema.optional(Schema.Boolean),
    ask: Schema.optional(Schema.String),
    answered: Schema.optional(Schema.Boolean),
  });
  const ControlsFile = Schema.Struct({
    version: Schema.Literal(1),
    activityIndexed: Schema.optional(Schema.Boolean),
    threads: Schema.Record(Schema.String, ThreadFile),
  });
  const decodeControls = Schema.decodeUnknownEffect(Schema.fromJsonString(ControlsFile));
  const encodeControls = Schema.encodeEffect(Schema.fromJsonString(ControlsFile));

  function recordFromFile(value: typeof ThreadFile.Type): ChatControlRecord {
    const record = emptyRecord();
    record.override =
      value.override === "include" || value.override === "exclude" ? value.override : null;
    for (const day of value.days ?? []) if (DAY.test(day)) record.days.add(day);
    const last = instantMs(value.lastActiveAt ?? null);
    record.lastActiveAt = last === null ? null : (value.lastActiveAt ?? null);
    record.subagents = value.subagents !== false;
    record.notice = value.notice === true;
    // An ask still open in the file is from before a restart: its minute is over.
    record.answered = value.answered === true || value.ask !== undefined;
    record.ask = null;
    return record;
  }

  function mergeRecords(
    file: ChatControlRecord | undefined,
    memory: ChatControlRecord | undefined,
  ) {
    if (file === undefined) return memory;
    if (memory === undefined) return file;
    const days = new Set([...file.days, ...memory.days]);
    const last =
      (instantMs(memory.lastActiveAt) ?? -1) > (instantMs(file.lastActiveAt) ?? -1)
        ? memory.lastActiveAt
        : file.lastActiveAt;
    const answered = memory.answered || file.answered;
    return {
      override: memory.override ?? file.override,
      days,
      lastActiveAt: last,
      subagents: memory.subagents && file.subagents,
      notice: memory.notice || file.notice,
      ask: answered ? null : (memory.ask ?? file.ask),
      answered,
    } satisfies ChatControlRecord;
  }

  function isStored(record: ChatControlRecord): boolean {
    return (
      record.override !== null ||
      record.days.size > 0 ||
      record.lastActiveAt !== null ||
      record.subagents === false ||
      record.notice ||
      record.ask !== null ||
      record.answered
    );
  }

  function subscribeSubagentsChanged(listener: () => void): () => void {
    subagentListeners.add(listener);
    return () => subagentListeners.delete(listener);
  }

  const chatControls = {
    /** The one-time history scan is due: the saved file is loaded and has not recorded it. */
    needsActivityIndex(): boolean {
      return hydrated && !activityIndexed;
    },
    markActivityIndexed() {
      if (activityIndexed) return;
      activityIndexed = true;
      touch();
    },
    view(threadId: string): ChatControlView {
      return viewOf(threads.get(threadId));
    },
    /** In force for this chat: its own switch, unless Settings > Agents has subagents at None. */
    subagentsEnabled(threadId: string): boolean {
      return (
        !subagentsOffInSettings() &&
        threads.get(threadId)?.subagents !== false &&
        botAllowsSubagents(threadId)
      );
    },
    /**
     * Records instants newer than the stored last-active time. History is the
     * startup backfill's job, so a sidebar read cannot walk old messages.
     */
    observeActivity(threadId: string, instants: ReadonlyArray<string | null>) {
      const existing = threads.get(threadId);
      const record = existing ?? emptyRecord();
      let changed = false;
      for (const instant of instants) {
        if (instant !== null && rememberNewer(record, instant)) changed = true;
      }
      if (!changed) return;
      threads.set(threadId, record);
      touch();
    },
    /** Unions timestamp history. Returns thread ids whose shell fields changed. */
    mergeActivity(
      rows: ReadonlyArray<{ readonly threadId: string; readonly at: string }>,
    ): string[] {
      const changed = new Set<string>();
      for (const row of rows) {
        const before = viewOf(threads.get(row.threadId));
        const record = ensure(row.threadId);
        if (!addActivity(record, row.at)) continue;
        if (!sameView(before, viewOf(record))) changed.add(row.threadId);
      }
      const ids = [...changed];
      if (ids.length > 0) {
        touch();
        announce(ids);
      }
      return ids;
    },
    /**
     * True when this user message should carry the one-line notice. A session
     * that has not started yet gets the current rules instead, and the notice
     * is still consumed so it cannot fire on a later turn.
     */
    consumeSubagentNotice(threadId: string, sessionLive: boolean): boolean {
      const record = threads.get(threadId);
      const offInSettings = subagentsOffInSettings();
      const nowEffective =
        !offInSettings && record?.subagents !== false && botAllowsSubagents(threadId);
      const prevEffective =
        seenEffective.get(threadId) ??
        (() => {
          const initialSettingsOff = settingsFlips % 2 === 1 ? !offInSettings : offInSettings;
          const initialOwn =
            record?.notice === true ? !record.subagents : record?.subagents !== false;
          return !initialSettingsOff && initialOwn && botAllowsSubagents(threadId);
        })();
      seenEffective.set(threadId, nowEffective);
      if (record?.notice === true) {
        record.notice = false;
        touch();
      }
      return sessionLive && nowEffective !== prevEffective;
    },
    command(command: ChatControlsCommand): Effect.Effect<void, ChatControlsError> {
      return Effect.sync(() => {
        if (command.action === "long-running") {
          const record = ensure(command.threadId);
          if (record.override === command.placement) return;
          record.override = command.placement;
          touch();
          announce([command.threadId]);
          return;
        }
        setSubagents(command.threadId, command.enabled);
      });
    },
    /** False until this chat's first subagent was looked up, or once it was answered. */
    firstSubagentChecked(threadId: string): boolean {
      return firstSubagentChecked.has(threadId) || threads.get(threadId)?.answered === true;
    },
    firstSubagentAnswered(threadId: string): boolean {
      return threads.get(threadId)?.answered === true;
    },
    /** The stored ask, regardless of the switch. */
    firstSubagentAsk(threadId: string): string | null {
      return threads.get(threadId)?.ask ?? null;
    },
    /** Opens the ask for a running first subagent, or closes it with null. */
    setFirstSubagentAsk(threadId: string, taskId: string | null) {
      firstSubagentChecked.add(threadId);
      const existing = threads.get(threadId);
      if (existing?.answered === true || (existing?.ask ?? null) === taskId) return;
      ensure(threadId).ask = taskId;
      touch();
      announce([threadId]);
      if (taskId === null) return;
      // No answer within the minute keeps things as they are: the same as "Fine".
      afterAskDelay(() => {
        const record = threads.get(threadId);
        if (record === undefined || record.answered || record.ask !== taskId) return;
        record.answered = true;
        record.ask = null;
        touch();
        announce([threadId]);
      });
    },
    /**
     * Closes the ask for good. "solo" also turns the switch off, the same way
     * the composer does. False when the chat had already answered.
     */
    answerFirstSubagent(threadId: string, verdict: FirstSubagentVerdict): boolean {
      const record = ensure(threadId);
      if (record.answered) return false;
      record.answered = true;
      record.ask = null;
      firstSubagentChecked.add(threadId);
      touch();
      announce([threadId]);
      if (verdict === "solo") setSubagents(threadId, false);
      return true;
    },
  };

  function setSubagents(threadId: string, enabled: boolean) {
    const record = ensure(threadId);
    if (record.subagents === enabled) return;
    record.subagents = enabled;
    // Flipping back before the agent saw the first change leaves it with nothing to learn.
    record.notice = record.notice !== true;
    touch();
    announce([threadId]);
    notifySubagents();
  }

  /** Loads the saved record at startup and writes it as it changes. */
  const load = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(config.stateDir, CONTROLS_FILE);
    const empty: typeof ControlsFile.Type = { version: 1, threads: {} };
    // A missing file starts empty. An unreadable one is set aside, never overwritten,
    // so manual placements and Subagents switches are not silently lost.
    const saved = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeControls),
      Effect.catchIf(
        (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
        () => Effect.succeed(empty),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read chat controls; starting empty.", { cause }).pipe(
          Effect.andThen(fs.rename(file, `${file}.unreadable`).pipe(Effect.ignore)),
          Effect.as(empty),
        ),
      ),
    );
    activityIndexed = activityIndexed || saved.activityIndexed === true;
    const loaded = new Map<string, ChatControlRecord>();
    for (const [threadId, value] of Object.entries(saved.threads)) {
      const record = recordFromFile(value);
      if (isStored(record)) loaded.set(threadId, record);
    }
    const before = new Map(threads);
    threads.clear();
    const announceIds: string[] = [];
    const ids = new Set([...loaded.keys(), ...before.keys()]);
    for (const threadId of ids) {
      const merged = mergeRecords(loaded.get(threadId), before.get(threadId));
      const previous = viewOf(before.get(threadId));
      if (merged !== undefined && isStored(merged)) threads.set(threadId, merged);
      if (!sameView(previous, viewOf(threads.get(threadId)))) announceIds.push(threadId);
    }
    hydrated = true;
    const save = Effect.gen(function* () {
      const encodedThreads: Record<string, typeof ThreadFile.Type> = {};
      for (const [threadId, record] of threads) {
        if (!isStored(record)) continue;
        encodedThreads[threadId] = {
          ...(record.override === null ? {} : { override: record.override }),
          ...(record.days.size === 0 ? {} : { days: [...record.days].toSorted() }),
          ...(record.lastActiveAt === null ? {} : { lastActiveAt: record.lastActiveAt }),
          ...(record.subagents ? {} : { subagents: false }),
          ...(record.notice ? { notice: true } : {}),
          ...(record.ask === null ? {} : { ask: record.ask }),
          ...(record.answered ? { answered: true } : {}),
        };
      }
      const encoded = yield* encodeControls({
        version: 1,
        ...(activityIndexed ? { activityIndexed: true } : {}),
        threads: encodedThreads,
      });
      yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: 0o600 });
      yield* fs.rename(`${file}.tmp`, file);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not save chat controls.", { cause })),
    );
    const saves = yield* Queue.sliding<void>(1);
    // Saves coalesce; `dirty` lets shutdown write the last change instead of dropping it.
    let dirty = false;
    const flush = Effect.suspend(() => {
      if (!dirty) return Effect.void;
      dirty = false;
      return save;
    }).pipe(Effect.uninterruptible);
    onChange = () => {
      dirty = true;
      Queue.offerUnsafe(saves, undefined);
    };
    if (announceIds.length > 0 || before.size > 0) touch();
    announce(announceIds);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (onChange = null)).pipe(Effect.andThen(flush)),
    );
    yield* Queue.take(saves).pipe(Effect.andThen(flush), Effect.forever, Effect.forkScoped);
    // hydrated is read by tests that race the file; the flag is the barrier.
    void hydrated;
  });

  return { store: { ...chatControls, subscribeSubagentsChanged }, load };
}

const layerForStore = (store: ChatControls["Service"]) =>
  Layer.merge(
    Layer.succeed(ChatControls, store),
    Layer.succeed(SubagentsEnabled, (threadId) =>
      threadId === undefined
        ? currentAgentBehavior().subagents !== "none"
        : store.subagentsEnabled(threadId),
    ),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const instance = make();
    yield* instance.load;
    return layerForStore(instance.store);
  }),
);
