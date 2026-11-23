import { describe, expect, it } from "vite-plus/test";

import {
  commandLine,
  needsYouReason,
  needsYouScore,
  sameSessionTopic,
  sessionBoxActivity,
  sessionBoxNow,
  sessionBoxAttention,
  sessionBoxName,
  type NeedsYouInput,
} from "./index.ts";
import { hashedLinearScores, type HashedLinearModel } from "./model.ts";
import { sessionBoxLabelModels } from "./label.ts";
import { sessionBoxActivityModels } from "./activity.ts";
import { sessionBoxAttentionModels } from "./attention.ts";
import { SESSION_BOX_ACTIVITIES, SESSION_BOX_ATTENTION, SESSION_BOX_TOPICS } from "./taxonomy.ts";

describe("sessionBoxName", () => {
  it("shows a title that fits and drops the weakest words from one that doesn't", () => {
    expect(sessionBoxName("Benchmark DeepSeek V4.1 Flash Speed").label).toBe(
      "Benchmark DeepSeek V4.1 Flash Speed",
    );
    expect(sessionBoxName("Benchmark DeepSeek V4.1 Flash Speed", { maxChars: 28 }).label).toBe(
      "DeepSeek V4.1 Flash Speed",
    );
    expect(sessionBoxName("Free Up MacBook Storage")).toMatchObject({ topic: "cleanup" });
    expect(sessionBoxName("Fix Cove Native Video Playback", { maxChars: 28 }).label).not.toMatch(
      /^Fix/,
    );
    expect(
      sessionBoxName("Streamline SSHCode Harness and Mobile UX", { maxChars: 28 }).label,
    ).toContain("SSHCode Harness");
  });

  it("drops a prefix most sibling boxes share", () => {
    const siblings = [
      "example.dev · orrery",
      "example.dev · tabs",
      "example.dev · radio",
      "Studio Console",
    ];
    expect(
      sessionBoxName("example.dev · QA-31 orrery + ascii (Haiku)", { siblingTitles: siblings })
        .label,
    ).not.toContain("example.dev");
  });

  it("marks placeholder titles and reads link text", () => {
    expect(sessionBoxName("Start a conversation")).toMatchObject({
      meaningful: false,
      topic: "general",
    });
    expect(sessionBoxName("[AI Tracker Bot megathread](t3-context://v1/thread/x)").label).toContain(
      "Tracker",
    );
  });
});

describe("sessionBoxNow", () => {
  it("says what a chat that moved on from its title is on now, in the user's words", () => {
    const title = "Streamline SSHCode Harness and Mobile UX";
    expect(sessionBoxNow("And what is generating these new titles", title)).toBe(
      "What is generating these new titles",
    );
    expect(sessionBoxNow("can you sideload the best youtube one\nthanks", "Sideload Kettu")).toBe(
      "Sideload the best youtube one",
    );
  });

  it("stays quiet for short replies and requests that repeat the title", () => {
    expect(sessionBoxNow("yes do it", "Anything")).toBeNull();
    expect(
      sessionBoxNow("Can you refresh the Studio Console on mobile", "Studio Console Mobile"),
    ).toBeNull();
  });

  it("cuts a long request at a word", () => {
    const now = sessionBoxNow(
      "the charter assigns sol-fuse a twelve dollar modal budget, but the rules also say more",
      "DS41 fused routes",
    );
    expect(now?.endsWith("…")).toBe(true);
    expect(now!.length).toBeLessThanOrEqual(61);
  });
});

describe("sessionBoxActivity", () => {
  it("reads commands and tools", () => {
    expect(
      sessionBoxActivity({ itemType: "command_execution", detail: "cd app && pnpm vitest run" }),
    ).toBe("testing");
    expect(sessionBoxActivity({ itemType: "command_execution", detail: "rg -n foo src" })).toBe(
      "searching",
    );
    expect(
      sessionBoxActivity({ itemType: "command_execution", detail: "ssh workstation nvidia-smi" }),
    ).toBe("remote");
    expect(sessionBoxActivity({ itemType: "file_change", detail: "Sidebar.tsx" })).toBe("editing");
    expect(sessionBoxActivity({ itemType: "dynamic_tool", detail: "delegate_task" })).toBe(
      "delegating",
    );
  });

  it("classifies the command inside provider shell wrappers", () => {
    const raw = '/bin/zsh -lc "cd /tmp/project && CI=1 timeout 30 pnpm vitest run"';
    expect(commandLine(raw)).toBe("pnpm vitest run");
    expect(sessionBoxActivity({ itemType: "command_execution", detail: raw })).toBe("testing");
    expect(commandLine("bash -lc 'cd /tmp/project && git diff --stat'")).toBe("git diff --stat");
  });
});

describe("commandLine", () => {
  it("unwraps shells, cd prefixes and env assignments", () => {
    expect(commandLine(`/bin/zsh -lc "cd /tmp/app && pnpm test"`)).toBe("pnpm test");
    expect(commandLine("FOO=1 BAR='x y' timeout 60 python3 run.py")).toBe("python3 run.py");
    expect(
      sessionBoxActivity({ itemType: "command_execution", detail: `bash -lc 'rg -n foo'` }),
    ).toBe("searching");
  });
});

describe("sessionBoxAttention", () => {
  it("tells asks from reports", () => {
    expect(sessionBoxAttention("All done. Want me to also update the docs?")).toBe("decision");
    expect(
      sessionBoxAttention("I couldn't reach the phone. Please unlock it and plug it in."),
    ).toBe("blocked");
    expect(sessionBoxAttention("Installed build 50 on the iPhone.")).toBe("review");
    expect(sessionBoxAttention("Which port does the old server use?")).toBe("question");
  });

  it("uses the final ask and ignores questions outside the reply tail", () => {
    expect(sessionBoxAttention("Installed the preview. I'm still checking the login flow.")).toBe(
      "progress",
    );
    expect(
      sessionBoxAttention(
        "Which color should I use? " +
          "The answer is available. ".repeat(40) +
          "The explanation is complete.",
      ),
    ).toBe("done");
    expect(
      sessionBoxAttention("The changes are ready. What is the hostname of the staging server?"),
    ).toBe("question");
    expect(sessionBoxAttention("")).toBe("done");
  });
});

describe("local model encoding", () => {
  it("keeps the rule fallbacks usable without installed weights", () => {
    const saved = {
      ...sessionBoxLabelModels,
      ...sessionBoxActivityModels,
      ...sessionBoxAttentionModels,
    };
    sessionBoxLabelModels.topic = null;
    sessionBoxLabelModels.keep = null;
    sessionBoxActivityModels.command = null;
    sessionBoxAttentionModels.reply = null;
    try {
      expect(sessionBoxName("Free Up Laptop Storage").topic).toBe("cleanup");
      expect(
        sessionBoxActivity({ itemType: "command_execution", detail: "rg -n symbol src" }),
      ).toBe("searching");
      expect(sessionBoxAttention("Want me to publish the preview?")).toBe("decision");
    } finally {
      sessionBoxLabelModels.topic = saved.topic;
      sessionBoxLabelModels.keep = saved.keep;
      sessionBoxActivityModels.command = saved.command;
      sessionBoxAttentionModels.reply = saved.reply;
    }
  });

  it("reads signed bucket-major int8 weights and repeated features", () => {
    const model: HashedLinearModel = {
      version: 1,
      buckets: 2,
      classes: ["a", "b"],
      scale: 0.5,
      weights: "Af4D/A==",
      bias: [0.1, -0.1],
    };
    const scores = hashedLinearScores(model, ["a", "b", "a"]);
    expect(scores[0]).toBeCloseTo(2.6);
    expect(scores[1]).toBeCloseTo(-4.1);
  });

  it("installs every fixed class in the same order within the mobile size budget", () => {
    const { topic, keep } = sessionBoxLabelModels;
    const { command } = sessionBoxActivityModels;
    const { reply } = sessionBoxAttentionModels;
    expect(topic?.classes).toEqual(SESSION_BOX_TOPICS);
    expect(keep?.classes).toEqual(["drop", "keep"]);
    expect(command?.classes).toEqual(SESSION_BOX_ACTIVITIES);
    expect(reply?.classes).toEqual(SESSION_BOX_ATTENTION);
    const models = [topic, keep, command, reply];
    expect(
      models.reduce((bytes, model) => bytes + (model?.weights.length ?? 0), 0),
    ).toBeLessThanOrEqual(1_500_000);
    for (const model of models) {
      expect(model).not.toBeNull();
      expect(atob(model!.weights).length).toBe(model!.buckets * model!.classes.length);
    }
  });
});

describe("needsYou", () => {
  const base: NeedsYouInput = {
    pendingRequest: null,
    attention: "done",
    working: false,
    failed: false,
    limited: false,
    unseen: false,
    hasActionablePlan: false,
    hasUnsentDraft: false,
    pinned: false,
    completedAt: 0,
    lastUserMessageAt: 0,
    createdAt: 0,
    now: 3_600_000,
  };
  it("puts blocked chats above unseen results above quiet ones", () => {
    const asking = needsYouScore({ ...base, pendingRequest: "user_input" });
    const unseen = needsYouScore({ ...base, unseen: true, attention: "review" });
    const quiet = needsYouScore(base);
    const working = needsYouScore({ ...base, working: true, attention: null });
    expect(asking).toBeGreaterThan(unseen);
    expect(unseen).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(working);
    expect(needsYouReason({ ...base, pendingRequest: "approval" })).toBe("approval");
    expect(needsYouReason(base)).toBeNull();
  });

  it("holds a chat only for a pending request or plan, never for what a reply says", () => {
    const unseen = { ...base, unseen: true };
    expect(needsYouReason({ ...unseen, attention: "question" })).toBe("results");
    expect(needsYouReason({ ...unseen, attention: "blocked" })).toBe("results");
    expect(needsYouReason({ ...unseen, attention: "decision" })).toBe("results");
    expect(needsYouReason({ ...unseen, attention: "progress" })).toBeNull();
    expect(needsYouReason({ ...base, attention: "question" })).toBeNull();
    expect(needsYouReason({ ...base, attention: "blocked", failed: true })).toBeNull();
    expect(needsYouReason({ ...base, pendingRequest: "user_input" })).toBe("question");
    expect(needsYouReason({ ...base, hasActionablePlan: true })).toBe("plan");
  });

  it("keeps old pending requests ahead of fresh completed work", () => {
    const fresh = needsYouScore({
      ...base,
      unseen: true,
      attention: "review",
      failed: true,
      hasActionablePlan: true,
      hasUnsentDraft: true,
      pinned: true,
      completedAt: base.now,
    });
    for (const pendingRequest of ["approval", "user_input", "secret"] as const) {
      expect(
        needsYouScore({
          ...base,
          pendingRequest,
          completedAt: null,
          lastUserMessageAt: null,
          createdAt: 0,
          now: 365 * 24 * 3_600_000,
        }),
      ).toBeGreaterThan(fresh);
    }
  });
});

describe("sameSessionTopic", () => {
  it("matches two phrasings of one topic and not different topics", () => {
    expect(sameSessionTopic("Studio phone pairing", "Pairing Studio with the iPhone")).toBe(true);
    expect(sameSessionTopic("Dynamic session titles", "Session titles follow the work")).toBe(true);
    expect(sameSessionTopic("Studio phone pairing", "Needs you rules")).toBe(false);
    expect(sameSessionTopic("yes", "Studio phone pairing")).toBe(false);
  });
});
