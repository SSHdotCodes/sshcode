import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_AGENT_BEHAVIOR } from "@t3tools/contracts";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SOLO,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SUBAGENT,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
  orchestrationInstructionsFor,
  registerAgentBehavior,
  registerGradingEnabled,
  registerRankedTaskKinds,
  t3AcpPromptWithInstructions,
  t3AcpInstructionState,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("teaches Antigravity its native media viewer once per session", () => {
    const state = t3AcpInstructionState({
      interactionMode: "default",
      hasT3Mcp: false,
      runtimeHarness: "Antigravity",
    });
    assert.include(
      t3AcpPromptWithInstructions({ prompt: "Inspect this path.", state }),
      "use read_file for video and audio",
    );
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Continue.", state, previousState: state }),
      "Continue.",
    );
  });

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
      "as applicable instructions, these explicitly ask for sub-agents, delegation, and parallel agent work without the user asking",
      "while you work on your piece (never serially while you wait)",
      // Leads stalled main work on side tasks; reviewers kept this example (11-26 evals).
      "a sizable side task that would stall your main work",
      // A fresh agent found a startup bug its lead had misdiagnosed twice (2026-11-10).
      "a fresh look after two wrong diagnoses",
      "Check SSHCode UI changes with `qa_sandbox`",
      "Delegate only when it clearly beats doing the work yourself after counting the brief, wait and review",
      "independent hour-plus pieces in parallel",
      "withEdits:true",
      "self-contained builds/demos the user judges by their result",
      "Skip subagents for small or tightly coupled work",
      "control and export scripts included",
      "supply the design if delegating UI code",
      "verify on the real surface (not just proxy checks)",
      "Give a reviewer the code/diff and acceptance criteria, not your conclusion",
      "verify other work yourself by running or inspecting it",
      "Use `council` when asked for multiple views or before a hard-to-reverse design choice",
      "Spare quota elsewhere, or your own running high, is no reason",
      "about 97% used or limited",
      "Run background subagents through `delegate_task`, never a background `Agent`",
      "holds for the whole chat",
      "keeping the plan, critical path",
      "Explicit user model choices and reviewer counts come first",
      "ceiling",
      "measure end to end first",
      "Native subagents share your quota",
      "recentFailure",
      "preferring other providers' best-fit models (especially for reviews)",
      "not price tier (benchmarks like Artificial Analysis or Terminal-Bench help)",
      "Skip `supersededBy`/legacy models unless explicitly requested",
      'isolation:"worktree"',
      "Make every brief self-contained",
      "if you can't write a clear brief, don't hand it off yet",
      "Once delegated, don't also do that work yourself",
      "when only waiting remains, end your turn without narrating, polling",
      "after checking any claim",
      "message mid-run only if blocked or the plan changes",
      "shared file",
      "`t3_pending_request_respond`",
      "ask via `ask_user`",
      "Use `ask_user`, not prose",
      "continue independent work",
      "'(Recommended)'",
      // The 10-minute default, important cards, secret delivery and the other monitor
      // options live in those tools' descriptions (apps/server orchestrator tools.test.ts).
      "Collect secrets with `request_secret`",
      "never ask for either in chat",
      "Use `create_threads` only for user-requested",
      "exact returned id",
      "`monitor_start`",
      "or their files",
      "Batch independent reads and searches in one tool round",
      "preserve the exit status",
      "line-buffered milestones",
      "wakeOn:false",
      "waits under an hour can use a native Monitor or background command",
      "longer waits use `monitor_start`",
      "`durable:true` for your own process",
      "read-only check with `restartable:true`",
      "(durable takes neither)",
      "check `monitor_list` after a restart",
      "Before ending a turn while your own long work still runs",
    ])
      assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, guidance);
    // The chat already shows what an agent waits on; listing it again is noise.
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "what will wake you");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS.toLowerCase(), "helper");
    // Model choice is judgment: no provider nudges (owner, 11-26) and no research push.
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Grok");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS.toLowerCase(), "research");
  });

  it("gives subagents their brief and operational rules without lead policies", () => {
    for (const enabled of [false, true]) {
      const rules = orchestrationInstructionsFor("child", () => enabled, true);
      assert.equal(rules, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT);
      assert.include(rules, "You are a subagent: a lead reads your final reply.");
      assert.include(rules, "start subagents only if asked");
      assert.include(rules, "Ask via `ask_user` only when blocked");
      assert.include(rules, "Commit or save notes as you go");
      assert.include(rules, "Keep your final reply concise (<5 KB): verdict first,");
      assert.include(rules, "what you did, exact checks run and results, open risks");
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

  it("delivers the native ACP tool catalog when it changes", () => {
    const prompt = "Continue.";
    const initial = t3AcpInstructionState({
      interactionMode: "default",
      hasT3Mcp: true,
      toolDiscoveryInstructions: "request_api_key — Request a reusable key privately.",
    });
    assert.include(t3AcpPromptWithInstructions({ prompt, state: initial }), "request_api_key —");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: initial, previousState: initial }),
      prompt,
    );

    const updated = t3AcpInstructionState({
      ...initial,
      toolDiscoveryInstructions: "schedule_task — Schedule work.",
    });
    const next = t3AcpPromptWithInstructions({ prompt, state: updated, previousState: initial });
    assert.include(next, "schedule_task —");
    assert.notInclude(next, "request_api_key");
    assert.notInclude(next, "## T3 Code orchestration");
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
      assert.include(
        rules,
        "Review, verify on the real surface (not just proxy checks), and integrate what subagents return. Don't over-trust",
      );
      const acp = t3AcpPromptWithInstructions({
        prompt: "hi",
        state: { interactionMode: "default", hasT3Mcp: true },
      });
      assert.notInclude(acp, "grades");
    } finally {
      registerGradingEnabled(() => true);
    }
    assert.include(orchestrationInstructionsFor(undefined), "flag a subagent that fell short");
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
      "For speed goals",
      "Explicit user model choices",
      "Honor the user's models",
      "`delegate_task` starts",
      "Worktree isolation",
      "While subagents run",
      "flag a subagent that fell short",
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
      assert.include(
        none,
        "- Explicit user model choices and reviewer counts come first ('Up to N' is a ceiling). Otherwise pick current models",
      );

      registerRankedTaskKinds(() => ["review"]);
      assert.include(
        orchestrationInstructionsFor(undefined),
        "For review work only, check `model_preferences` before delegating and pick the current model",
      );
    } finally {
      registerRankedTaskKinds(() => null);
    }
    // Not known yet: the general rule stays.
    assert.equal(orchestrationInstructionsFor(undefined), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });
});

describe("Settings > Agents behavior levels", () => {
  it("keeps every default level byte-identical to today across lead, solo, subagent and ACP", () => {
    registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
    assert.equal(orchestrationInstructionsFor(undefined), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.equal(
      orchestrationInstructionsFor("solo", () => false),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO,
    );
    assert.equal(
      orchestrationInstructionsFor("child", () => true, true),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
    );
  });

  it("handles subagents none, low and high cleanly for leads and subagents", () => {
    try {
      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, subagents: "none" }));
      const noneLead = orchestrationInstructionsFor("team", () => true, false);
      assert.equal(noneLead, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO);
      assert.notInclude(noneLead, "delegate_task");
      assert.notInclude(noneLead, "orchestrator_capabilities");
      const noneAcp = t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: t3AcpInstructionState({
          interactionMode: "default",
          hasT3Mcp: true,
          subagentsEnabled: true,
        }),
      });
      assert.notInclude(noneAcp, "acp-mcp-call delegate_task");

      const noneSub = orchestrationInstructionsFor("child", () => true, true);
      assert.equal(noneSub, T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT);

      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, subagents: "low" }));
      const lowLead = orchestrationInstructionsFor("team", () => true, false);
      assert.include(lowLead, "Subagents to Low");
      assert.include(lowLead, "user explicitly asks");
      assert.notInclude(lowLead, "Delegate only when it clearly beats");
      assert.include(
        lowLead,
        "Don't over-trust code you wrote: check your work yourself by running, testing or looking at it.",
      );
      assert.notInclude(lowLead, "another provider's review usually pays off");
      assert.equal(
        orchestrationInstructionsFor("child", () => true, true),
        T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
      );

      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, subagents: "high" }));
      const highLead = orchestrationInstructionsFor("team", () => true, false);
      assert.include(highLead, "Subagents to High");
      assert.include(highLead, "council");
      assert.include(highLead, "The user's word on subagents holds for the whole chat.");
      assert.notInclude(highLead, "do almost all of the work yourself");
      assert.include(highLead, "Even on High, stay solo for tiny one-step lookups");
      assert.notInclude(highLead, "Skip subagents for small or tightly coupled work");
      assert.include(
        highLead,
        "on High, these instructions explicitly ask for another provider's fresh-eyed subagent review",
      );
      assert.notInclude(highLead, "another provider's review usually pays off");
      assert.equal(
        orchestrationInstructionsFor("child", () => true, true),
        T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
      );

      // ACP subagent transport fallback replaces `orchestrator_capabilities` with `t3_thread_list`
      // and drops the delegate example sentence.
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
      const acpSub = t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: t3AcpInstructionState({
          interactionMode: "default",
          hasT3Mcp: true,
          isSubagent: true,
        }),
      });
      assert.include(acpSub, "acp-mcp-call t3_thread_list");
      assert.notInclude(acpSub, "acp-mcp-call orchestrator_capabilities");
      assert.notInclude(acpSub, "acp-mcp-call delegate_task");
    } finally {
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
    }
  });

  it("applies questions, verification and replies levels where appropriate", () => {
    try {
      registerAgentBehavior(() => ({
        ...DEFAULT_AGENT_BEHAVIOR,
        questions: "more",
        verification: "thorough",
        replies: "detailed",
      }));
      const lead = orchestrationInstructionsFor("team", () => true, false);
      assert.include(lead, "Questions to More");
      assert.include(lead, "Checking work to Thorough");
      assert.include(lead, "another model's independent review");
      assert.include(lead, "Replies to Detailed");

      // Subagents ignore questions:more (still ask only when blocked) and solo review hint.
      const sub = orchestrationInstructionsFor("child", () => true, true);
      assert.notInclude(sub, "Questions to More");
      assert.include(sub, "Ask via `ask_user` only when blocked");
      assert.include(sub, "Checking work to Thorough");
      assert.notInclude(sub, "another model's independent review");
      assert.include(sub, "Replies to Detailed");

      registerAgentBehavior(() => ({
        ...DEFAULT_AGENT_BEHAVIOR,
        questions: "fewer",
        verification: "light",
        replies: "short",
      }));
      const leadLight = orchestrationInstructionsFor("team", () => true, false);
      assert.include(leadLight, "Questions to Fewer");
      assert.include(leadLight, "Checking work to Light");
      assert.include(leadLight, "Replies to Short");
      const subLight = orchestrationInstructionsFor("child", () => true, true);
      assert.include(subLight, "Questions to Fewer");
      assert.include(subLight, "Checking work to Light");
      assert.include(subLight, "Replies to Short");
    } finally {
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
    }
  });

  it("trims instructions for tokens=low and adds report_progress guidance for tokens=high", () => {
    try {
      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "low" }));
      const lowLead = orchestrationInstructionsFor("team", () => true, false);
      assert.equal(lowLead, T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW);
      assert.isBelow(lowLead.length, 1400);
      assert.include(lowLead, "t3_tool");
      assert.include(lowLead, "delegate_task");
      assert.include(lowLead, "ask_user");
      assert.equal(
        orchestrationInstructionsFor("solo", () => false, false),
        T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SOLO,
      );
      assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SOLO, "delegate_task");
      assert.equal(
        orchestrationInstructionsFor("child", () => true, true),
        T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SUBAGENT,
      );

      registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" }));
      const highLead = orchestrationInstructionsFor("team", () => true, false);
      assert.include(highLead, "`report_progress`");
      assert.include(highLead, "minutes");
      assert.include(highLead, "every few minutes");
      const highSub = orchestrationInstructionsFor("child", () => true, true);
      assert.include(highSub, "`report_progress`");
    } finally {
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
    }
  });

  it("keeps forbidden words out of every non-default level combination", () => {
    try {
      for (const tokens of ["low", "default", "high"] as const) {
        for (const subagents of ["none", "low", "default", "high"] as const) {
          for (const questions of ["fewer", "default", "more"] as const) {
            for (const verification of ["light", "default", "thorough"] as const) {
              for (const replies of ["short", "default", "detailed"] as const) {
                registerAgentBehavior(() => ({
                  tokens,
                  subagents,
                  questions,
                  verification,
                  replies,
                }));
                for (const isSubagent of [false, true]) {
                  const text = orchestrationInstructionsFor(
                    "t",
                    () => true,
                    isSubagent,
                  ).toLowerCase();
                  for (const word of [
                    "risky",
                    "delet",
                    "always review",
                    "helper",
                    "grok",
                    "research",
                  ]) {
                    assert.notInclude(
                      text,
                      word,
                      `${tokens}/${subagents}/${questions}/${verification}/${replies}/sub=${isSubagent}`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    } finally {
      registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
    }
  });
});
