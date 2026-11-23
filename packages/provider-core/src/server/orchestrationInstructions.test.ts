import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
  orchestrationInstructionsFor,
  registerGradingEnabled,
  registerRankedTaskKinds,
  t3AcpPromptWithInstructions,
  t3AcpInstructionState,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("leaves review to judgment: neither forced nor skipped out of trust in its own code", () => {
    // No mandatory trigger; simple deletions and small changes stay the lead's call (2026-11-03).
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "risky");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "delet");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "always review");
    // Leads trusted unreviewed code that spent money or shaped training data (2026-11-08).
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Don't over-trust code you wrote");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "another provider's review usually pays off",
    );
  });

  it("keeps delegation, authorization, quota and question-card guidance", () => {
    for (const guidance of [
      "you lead",
      // The picked model is usually the strongest: it does the work, children only run beside it
      // (Alex 2026-11-10, after two weeks of use showed about 1.3 children at once in some chats).
      "usually the strongest one: you lead and do almost all of the work yourself",
      "hard problems",
      "while you work on your own piece, never one after another while you wait",
      // A fresh agent found a startup bug its lead had misdiagnosed twice (2026-11-10).
      "a fresh look after two wrong diagnoses",
      "Check SSHCode UI changes with `qa_sandbox`",
      "Decide on your own when other agents pay off",
      "split independent pieces of an hour or more each",
      "Do self-contained builds and demos the user judges by their result yourself",
      "skip subagents for small or tightly coupled work",
      "control and export scripts included",
      "if you delegate UI code, supply the design",
      "check other work yourself by running, testing or looking at it",
      "`council` asks 2-4 other models one question blind",
      "Spare quota elsewhere, or your own running high, is no reason",
      "about 97% used or limited",
      "A background child goes through `delegate_task`, never a background `Agent`.",
      "holds for the whole chat",
      "Keep the plan, critical path",
      "Honor the user's models and reviewer count",
      "ceiling",
      "measure end to end first",
      "native subagents share your quota",
      "For a review you do start, prefer another provider",
      "Skip small/fast models",
      "not price tier",
      "Never choose a `supersededBy` or legacy model by default",
      'isolation:"worktree"',
      "When only waiting is left, end your turn",
      "don't poll or start watchers for them",
      "after checking any claim you pass on",
      "done, blocked, or with a finding that changes the plan",
      "shared file",
      "`t3_pending_request_respond`",
      "ask the user with `ask_user`",
      "Ask with `ask_user`, not in your reply",
      "Continue independent work",
      "'(Recommended)'",
      // The 10-minute default, important cards, secret delivery and the other monitor
      // options live in those tools' descriptions (apps/server orchestrator tools.test.ts).
      "Collect secrets with `request_secret`",
      "never ask for either in chat",
      "Use `create_threads` only for user-requested",
      "exact returned id",
      "`monitor_start`",
      "or the files they write",
      "print only useful, line-buffered lines, then end your turn if waiting is all that's left",
      "Waits under an hour can use a native Monitor or background command",
      "longer ones use `monitor_start`",
      "`restartable:true` for read-only waits and checks",
      "with `durable:true` so restarts don't kill it",
      "after a restart check `monitor_list` before relaunching",
      "Before ending a turn while your own long work still runs",
    ])
      assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, guidance);
    // The chat already shows what an agent waits on; listing it again is noise.
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "what will wake you");
  });

  it("gives subagents their brief and operational rules without lead policies", () => {
    for (const enabled of [false, true]) {
      const rules = orchestrationInstructionsFor("child", () => enabled, true);
      assert.equal(rules, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT);
      assert.include(
        rules,
        "You are a subagent: a lead sent this brief and reads your final message.",
      );
      assert.include(rules, "start subagents only if the brief asks");
      assert.include(rules, "Ask via `ask_user` only when blocked");
      assert.include(rules, "what you did, what you verified and open risks");
      for (const dropped of [
        "you lead",
        "model_preferences",
        "orchestrator_capabilities",
        "usage_limits",
        "While subagents run",
        "child question cards",
        "important=true",
        "After 10 minutes",
        "council",
        "risky",
        "delet",
        "always review",
      ]) {
        assert.notInclude(rules, dropped);
      }
      for (const kept of [
        "qa_sandbox",
        "preview_*",
        "monitor_start",
        "monitor_list",
        "durable:true",
        "schedule_task",
        "request_secret",
        "request_api_key",
        "create_threads",
        "local time zone",
      ]) {
        assert.include(rules, kept);
      }
    }
    const state = t3AcpInstructionState({
      interactionMode: "default",
      hasT3Mcp: true,
      isSubagent: true,
    });
    const acp = t3AcpPromptWithInstructions({ prompt: "Do it.", state });
    assert.include(acp, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT.trim());
    assert.include(acp, "supported T3 transport fallback");
    assert.notInclude(acp, "orchestrator_capabilities");
    assert.notInclude(acp, "Delegate with");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.include(
      t3OrchestrationPromptForFirstRun({
        prompt: "Do it.",
        runOrdinal: 1,
        hasT3Mcp: true,
        isSubagent: true,
      }),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT.trim(),
    );
    assert.equal(
      t3OrchestrationSystemPrompt(true, "child", () => true, true),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
    );
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, orchestration and concise browser guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "SSHCode interaction mode: Default");
    assert.include(injected, "preview_*");
    assert.include(injected, "SSHCode orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("delivers ACP blocks independently, bootstraps new context and leaves slash commands intact", () => {
    const prompt = "Continue.";
    const state = t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: true });
    const full = t3AcpPromptWithInstructions({ prompt, state });
    assert.include(full, "<runtime_info>");
    assert.equal(t3AcpPromptWithInstructions({ prompt, state, previousState: state }), prompt);
    for (const mode of ["plan", "default"] as const) {
      const next = t3AcpInstructionState({ ...state, interactionMode: mode });
      const previous = t3AcpInstructionState({
        ...state,
        interactionMode: mode === "plan" ? "default" : "plan",
      });
      const delta = t3AcpPromptWithInstructions({ prompt, state: next, previousState: previous });
      assert.include(delta, `SSHCode interaction mode: ${mode === "plan" ? "Plan" : "Default"}`);
      assert.notInclude(delta, "SSHCode orchestration");
      assert.notInclude(delta, "ACP fallback");
      assert.notInclude(delta, "<runtime_info>");
      assert.isBelow(delta.length - prompt.length, 600);
    }
    assert.equal(t3AcpPromptWithInstructions({ prompt: "/compact", state }), "/compact");
    assert.include(t3AcpPromptWithInstructions({ prompt, state }), "SSHCode orchestration");
    const disconnected = t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: false });
    const lostTools = t3AcpPromptWithInstructions({
      prompt,
      state: disconnected,
      previousState: state,
    });
    assert.include(lostTools, "MCP tools are not attached");
    assert.include(lostTools, "terminal fallback is unavailable");
    const restored = t3AcpPromptWithInstructions({ prompt, state, previousState: disconnected });
    assert.include(restored, "SSHCode orchestration");
    assert.include(restored, "ACP fallback");
    assert.notInclude(restored, "interaction mode:");
    assert.notInclude(restored, "<runtime_info>");
  });

  it("refreshes changed grading policy without repeating mode, transport or runtime", () => {
    const state = t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: true });
    registerGradingEnabled(() => false);
    try {
      const next = t3AcpInstructionState(state);
      const delta = t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: next,
        previousState: state,
      });
      assert.include(delta, "SSHCode orchestration");
      assert.notInclude(delta, "grades");
      assert.notInclude(delta, "ACP fallback");
      assert.notInclude(delta, "interaction mode:");
      assert.notInclude(delta, "<runtime_info>");
    } finally {
      registerGradingEnabled(() => true);
    }
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "SSHCode interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "SSHCode interaction mode: Default");
    assert.notInclude(withoutMcp, "SSHCode collaborative browser");
    assert.notInclude(withoutMcp, "SSHCode orchestration");
  });

  it("drops only the grading clause when Settings turns grading off", () => {
    registerGradingEnabled(() => false);
    try {
      const rules = orchestrationInstructionsFor(undefined);
      assert.notInclude(rules, "grades");
      assert.include(rules, "Review and integrate what children return. `council`");
      const acp = t3AcpPromptWithInstructions({
        prompt: "hi",
        state: { interactionMode: "default", hasT3Mcp: true },
      });
      assert.notInclude(acp, "grades");
    } finally {
      registerGradingEnabled(() => true);
    }
    assert.include(orchestrationInstructionsFor(undefined), "rate each checked one via `grades`");
  });

  it("keeps the default rules byte-identical and drops subagent paragraphs when off", () => {
    assert.equal(orchestrationInstructionsFor(undefined), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    const subagentsEnabled = (threadId: string | undefined) => threadId !== "solo";
    assert.equal(
      orchestrationInstructionsFor("team", subagentsEnabled),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    );
    const solo = orchestrationInstructionsFor("solo", subagentsEnabled);
    assert.equal(solo, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO);
    assert.notEqual(solo, T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    for (const dropped of [
      "The user picked your model",
      "For a speed goal",
      "Explicit user model choices",
      "Honor the user's models",
      "`delegate_task` starts",
      "Worktree isolation",
      "While subagents run",
      "rate each checked one",
      "Answer child question cards",
    ]) {
      assert.notInclude(solo, dropped);
    }
    // Guard against rule edits that rename a bullet: the solo rules must not
    // mention any tool the switch hides, whatever the wording becomes.
    for (const hidden of ["delegate_task", "council", "task_status", "task_cancel"]) {
      assert.notInclude(solo, hidden);
    }
    for (const kept of [
      "qa_sandbox",
      "preview_*",
      "monitor_start",
      "ask_user",
      "schedule_task",
      "create_threads",
      "local time zone",
      "Before ending a turn",
    ]) {
      assert.include(solo, kept);
    }
    const first = t3OrchestrationPromptForFirstRun({
      prompt: "Do it.",
      runOrdinal: 1,
      hasT3Mcp: true,
      threadId: "solo",
      subagentsEnabled,
    });
    assert.include(first, "create_threads");
    assert.notInclude(first, "delegate_task` starts");
  });

  it("reinjects ACP guidance when subagents turn off and drops only the delegate sentence", () => {
    const prompt = "Continue.";
    const on = { interactionMode: "default" as const, hasT3Mcp: true, subagentsEnabled: true };
    const off = { ...on, subagentsEnabled: false };
    assert.equal(t3AcpPromptWithInstructions({ prompt, state: on, previousState: on }), prompt);
    const injected = t3AcpPromptWithInstructions({ prompt, state: off, previousState: on });
    assert.include(injected, "create_threads");
    assert.notInclude(injected, "delegate_task` starts");
    assert.notInclude(injected, "acp-mcp-call delegate_task");
    assert.include(injected, "acp-mcp-call orchestrator_capabilities");
    assert.include(injected, "supported T3 transport fallback");
  });
});

describe("model rankings rule", () => {
  it("is dropped when nothing is ranked, and names the ranked kinds of work otherwise", () => {
    try {
      registerRankedTaskKinds(() => []);
      const none = orchestrationInstructionsFor(undefined);
      assert.notInclude(none, "model_preferences");
      assert.include(none, "- Explicit user model choices come first.\n");

      registerRankedTaskKinds(() => ["review"]);
      assert.include(
        orchestrationInstructionsFor(undefined),
        "Otherwise, for review work only, consult `model_preferences` before delegating;",
      );
    } finally {
      registerRankedTaskKinds(() => null);
    }
    // Not known yet: the general rule stays.
    assert.equal(orchestrationInstructionsFor(undefined), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });
});
