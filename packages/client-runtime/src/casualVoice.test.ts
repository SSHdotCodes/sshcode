import { describe, expect, it } from "vite-plus/test";
import {
  ThreadId,
  MessageId,
  TurnItemId,
  ProviderInstanceId,
  type CasualVoiceReply,
} from "@t3tools/contracts";
import { createCasualVoiceStore } from "./casualVoice.ts";

const threadId = ThreadId.make("chat");
const backend = {
  kind: "provider",
  modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "test" },
} as const;
const reply: CasualVoiceReply = { enabled: true, backend, models: [] };
it("dedupes settings reads and keeps per-chat switches independent", async () => {
  const store = createCasualVoiceStore();
  let calls = 0;
  const send = async () => {
    calls++;
    return reply;
  };
  await Promise.all([
    store.load("mac\nchat", threadId, send),
    store.load("mac\nchat", threadId, send),
  ]);
  expect(calls).toBe(1);
  await store.load("mac\nother", ThreadId.make("other"), send);
  await store.configure(
    "mac\nchat",
    { action: "configure", threadId, enabled: false },
    async () => ({ ...reply, enabled: false }),
  );
  expect(store.get("mac\nchat").enabled).toBe(false);
  expect(store.get("mac\nother").enabled).toBe(true);
  expect(store.get("different-mac\nchat").backend).toBeNull();
});
it("updates backend choices within the destination environment and preserves chat overrides", async () => {
  const store = createCasualVoiceStore();
  await store.load("mac\na", threadId, async () => ({ ...reply, enabled: false }));
  await store.load("other\na", threadId, async () => reply);
  await store.configure("mac\nb", { action: "configure", threadId, backend: null }, async () => ({
    ...reply,
    backend: null,
  }));
  expect(store.get("mac\na")).toMatchObject({ enabled: false, backend: null });
  expect(store.get("other\na").backend).toEqual(backend);
});
describe("failed requests", () => {
  it("does not turn on or change a chat when saving fails", async () => {
    const store = createCasualVoiceStore();
    await store.load("mac\na", threadId, async () => ({ ...reply, enabled: false }));
    expect(
      await store.configure(
        "mac\na",
        { action: "configure", threadId, enabled: true },
        async () => null,
      ),
    ).toBe(false);
    expect(store.get("mac\na").enabled).toBe(false);
  });
});

it("folds update statuses into display work rows without changing original messages or other chats", async () => {
  const { parseCasualDecisions, segmentCasualMessage } =
    await import("@t3tools/shared/casualVoice");
  const original = Object.freeze({ id: "update", text: "Let me check the tests." });
  const display = parseCasualDecisions(
    segmentCasualMessage(original.text, "update"),
    "1 status: checking the tests",
  )!;
  const store = createCasualVoiceStore();
  await store.load("mac\nchat", threadId, async () => reply);
  await store.rewrite(
    "mac\nchat",
    threadId,
    (await import("@t3tools/contracts")).MessageId.make(original.id),
    async () => ({ ...reply, display }),
    "run",
    "update",
  );
  expect(store.status("mac\nchat", "run")).toBe("checking the tests");
  expect(store.status("other\nchat", "run")).toBe("");
  expect(original.text).toBe("Let me check the tests.");
  await store.configure(
    "mac\nchat",
    { action: "configure", threadId, enabled: false },
    async () => ({ ...reply, enabled: false }),
  );
  expect(store.status("mac\nchat", "run")).toBe("");
});

it("retains each steer status separately and forwards only the reasoning window identity", async () => {
  const { parseCasualDecisions, segmentCasualMessage } =
    await import("@t3tools/shared/casualVoice");
  const store = createCasualVoiceStore();
  const display = parseCasualDecisions(
    segmentCasualMessage("Let me check the tests.", "update", {
      source: "reasoning",
      replyTo: "continue",
    }),
    "1 status: checking the tests",
  )!;
  const sent: unknown[] = [];
  const send = async (input: unknown) => {
    sent.push(input);
    return { ...reply, display };
  };
  await store.rewrite(
    "mac\nchat",
    threadId,
    MessageId.make("steer"),
    send,
    "run",
    "update",
    TurnItemId.make("thought"),
  );
  expect(sent).toEqual([
    { action: "rewrite", threadId, messageId: "steer", role: "update", reasoningItemId: "thought" },
  ]);
  expect(store.status("mac\nchat", "run")).toBe("checking the tests");
});
it("settles a failed settings read so reasoning replies can use the original fallback", async () => {
  const store = createCasualVoiceStore();
  await store.load("mac\nchat", threadId, async () => null);
  expect(store.loaded("mac\nchat")).toBe(true);
  expect(store.get("mac\nchat").backend).toBeNull();
});

it("shares the mode and cloud model in one environment and records show-original by hash", async () => {
  const { parseCasualDecisions, segmentCasualMessage } =
    await import("@t3tools/shared/casualVoice");
  const store = createCasualVoiceStore();
  const cloud = {
    kind: "provider" as const,
    modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "cloud" },
  };
  await store.load("mac\na", threadId, async () => reply);
  await store.load("other\na", threadId, async () => reply);
  await store.configure(
    "mac\nb",
    { action: "configure", threadId, mode: "hybrid", cloudBackend: cloud, saveTraining: false },
    async () => ({ ...reply, mode: "hybrid", cloudBackend: cloud, saveTraining: false }),
  );
  expect(store.get("mac\na")).toMatchObject({
    enabled: true,
    backend,
    mode: "hybrid",
    cloudBackend: cloud,
    saveTraining: false,
  });
  expect(store.get("other\na").mode).toBeUndefined();
  const display = parseCasualDecisions(
    segmentCasualMessage("Hello there.", "final"),
    "1 say: hello there.",
  )!;
  const hash = "ab".repeat(32);
  await store.rewrite("mac\na", threadId, MessageId.make("reply"), async () => ({
    ...reply,
    mode: "hybrid",
    cloudBackend: cloud,
    display,
    inputHash: hash,
  }));
  expect(store.hash("mac\na", "reply")).toBe(hash);
  const sent: unknown[] = [];
  await store.feedback(threadId, hash.toUpperCase(), async (input) => {
    sent.push(input);
    return reply;
  });
  expect(sent).toEqual([{ action: "feedback", threadId, inputHash: hash }]);
  await store.feedback(threadId, "not-a-hash", async () => {
    throw new Error("feedback should ignore a hash that is not 64 hex characters");
  });
});

it("keeps the newest saved setting when an older read or save finishes last", async () => {
  const store = createCasualVoiceStore();
  const key = "mac\nchat";
  let finishRead: (value: CasualVoiceReply) => void = () => {};
  const loading = store.load(key, threadId, () => new Promise((resolve) => (finishRead = resolve)));
  await store.configure(key, { action: "configure", threadId, enabled: false }, async () => ({
    ...reply,
    enabled: false,
  }));
  finishRead(reply);
  await loading;
  expect(store.get(key).enabled).toBe(false);

  let finishFirst: (value: CasualVoiceReply) => void = () => {};
  const first = store.configure(
    key,
    { action: "configure", threadId, enabled: true },
    () => new Promise((resolve) => (finishFirst = resolve)),
  );
  await store.configure(key, { action: "configure", threadId, enabled: false }, async () => ({
    ...reply,
    enabled: false,
  }));
  finishFirst(reply);
  await first;
  expect(store.get(key).enabled).toBe(false);
});

describe("overlapping requests", () => {
  const deferred = () => {
    let resolve!: (value: CasualVoiceReply | null) => void;
    const promise = new Promise<CasualVoiceReply | null>((done) => (resolve = done));
    return { promise, resolve };
  };

  it("keeps a successful read when a later save fails", async () => {
    const store = createCasualVoiceStore();
    const read = deferred();
    const loading = store.load("mac\nchat", threadId, () => read.promise);
    await store.configure(
      "mac\nchat",
      { action: "configure", threadId, enabled: false },
      async () => null,
    );
    read.resolve(reply);
    await loading;
    expect(store.loaded("mac\nchat")).toBe(true);
    expect(store.get("mac\nchat").enabled).toBe(true);
  });

  it("shows an earlier save that succeeded when a later one fails", async () => {
    const store = createCasualVoiceStore();
    await store.load("mac\nchat", threadId, async () => reply);
    const first = deferred();
    const saving = store.configure(
      "mac\nchat",
      { action: "configure", threadId, enabled: false },
      () => first.promise,
    );
    await store.configure(
      "mac\nchat",
      { action: "configure", threadId, enabled: true },
      async () => null,
    );
    first.resolve({ ...reply, enabled: false });
    await saving;
    expect(store.get("mac\nchat").enabled).toBe(false);
  });

  it("keeps another chat's switch when an environment change lands first", async () => {
    const store = createCasualVoiceStore();
    await store.load("mac\na", threadId, async () => reply);
    await store.load("mac\nb", ThreadId.make("b"), async () => reply);
    const chatSave = deferred();
    const savingB = store.configure(
      "mac\nb",
      { action: "configure", threadId: ThreadId.make("b"), enabled: false },
      () => chatSave.promise,
    );
    await store.configure("mac\na", { action: "configure", threadId, mode: "cloud" }, async () => ({
      ...reply,
      mode: "cloud",
    }));
    // B's reply was computed before A's mode change reached the server.
    chatSave.resolve({ ...reply, enabled: false });
    await savingB;
    expect(store.get("mac\nb").enabled).toBe(false);
    expect(store.get("mac\nb").mode).toBe("cloud");
    expect(store.get("mac\na").enabled).toBe(true);
  });
});
