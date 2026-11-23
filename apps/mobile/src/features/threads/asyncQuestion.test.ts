import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "../../lib/threadActivity";
import { userInputOwnsComposer } from "./pendingUserInputLayout";

/** What the server records for an `ask_user` call: a message-mode request and its item. */
function askUserProjection(): Pick<
  OrchestrationV2ThreadProjection,
  "runtimeRequests" | "turnItems"
> {
  return {
    runtimeRequests: [
      {
        id: "request-ask-user",
        kind: "user_input",
        status: "pending",
        createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
        responseCapability: { type: "message" },
      },
    ],
    turnItems: [
      {
        type: "user_input_request",
        requestId: "request-ask-user",
        responseMode: "message",
        questions: [
          {
            id: "q1",
            header: "Targets",
            question: "Which platforms should the release cover?",
            options: [
              { label: "iOS", description: "iPhone and iPad" },
              { label: "Android", description: "Phones" },
              { label: "Web", description: "Browser" },
            ],
            multiSelect: true,
            allowCustomAnswer: true,
          },
          {
            id: "q2",
            header: "Notes",
            question: "Anything the release notes must mention?",
            options: [],
            allowCustomAnswer: true,
          },
        ],
      },
    ],
  } as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;
}

describe("ask_user questions", () => {
  it("are dismissible, answered by message, and leave the composer usable", () => {
    const [request] = derivePendingThreadRequests(askUserProjection()).userInputs;

    expect(request).toMatchObject({ dismissible: true, responseMode: "message" });
    expect(userInputOwnsComposer(request)).toBe(false);
    expect(userInputOwnsComposer({})).toBe(true);
    expect(userInputOwnsComposer(null)).toBe(false);
  });

  it("collect several choices and a free-text answer", () => {
    const [request] = derivePendingThreadRequests(askUserProjection()).userInputs;
    if (!request) throw new Error("Expected the ask_user request");
    const [targets, notes] = request.questions;
    if (!targets || !notes) throw new Error("Expected both questions");

    let draft = togglePendingUserInputOptionSelection(targets, undefined, "iOS");
    draft = togglePendingUserInputOptionSelection(targets, draft, "Web");
    expect(buildPendingUserInputAnswers(request.questions, { q1: draft })).toBeNull();

    const answers = buildPendingUserInputAnswers(request.questions, {
      q1: draft,
      q2: setPendingUserInputCustomAnswer(notes, undefined, "Mention the new sync engine"),
    });
    expect(answers).toEqual({ q1: ["iOS", "Web"], q2: "Mention the new sync engine" });
  });
});
