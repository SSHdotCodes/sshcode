import { SecretRequestError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  apiKeyCustomExpiry,
  apiKeyExpiryFromDays,
  secretAnswerNoticeIds,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
  type SecretRequestItem,
} from "./secretRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:secret-request:1"),
  threadId: ThreadId.make("thread-1"),
};

describe("secretRequestDisplay", () => {
  it("shows the form only while pending and maps every answer to its outcome copy", () => {
    const display = (secretStatus: SecretRequestItem["secretStatus"]) =>
      secretRequestDisplay({ secretStatus }, "local");
    expect(display("pending")).toEqual({ kind: "pending" });
    expect(display("saved")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Saved securely and kept private",
    });
    expect(display("declined")).toEqual({
      kind: "answered",
      outcome: "declined",
      label: "Declined",
    });
    expect(display("cancelled")).toEqual({
      kind: "answered",
      outcome: "ended",
      label: "Request ended",
    });
  });

  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestAnswerInput", () => {
  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(item, { type: "save", values: ["   "] })).toBeNull();
    expect(secretRequestAnswerInput(item, { type: "save", values: [" whsec_1 "] })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "whsec_1" },
    });
    expect(secretRequestAnswerInput(item, { type: "decline" })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "decline" },
    });
  });
});

describe("a credential in parts", () => {
  const fields = [{ label: "Token ID", placeholder: "ak-…" }, { label: "Token secret" }];
  const inParts = { ...item, label: "Modal token", fields };

  it("draws one labelled input per part, and one named by the card otherwise", () => {
    expect(secretRequestInputs(inParts)).toEqual([
      { label: "Token ID", placeholder: "ak-…" },
      { label: "Token secret", placeholder: "Paste the secret" },
    ]);
    expect(secretRequestInputs({ label: "GitHub token", placeholder: "ghp_…" })).toEqual([
      { label: "GitHub token", placeholder: "ghp_…" },
    ]);
  });

  it("sends every part in order, and only once each has a value", () => {
    expect(
      secretRequestAnswerInput(inParts, { type: "save", values: [" ak-1 ", "as-2"] })?.answer,
    ).toEqual({ type: "save", secrets: ["ak-1", "as-2"] });
    expect(secretRequestAnswerInput(inParts, { type: "save", values: ["ak-1", " "] })).toBeNull();
    expect(secretRequestAnswerInput(inParts, { type: "save", values: ["ak-1"] })).toBeNull();
    // A card without parts keeps the shape every server understands.
    expect(secretRequestAnswerInput(item, { type: "save", values: ["ak-1", "as-2"] })).toBeNull();
  });

  it("says how many parts were saved on its one row", () => {
    expect(secretRequestDisplay({ secretStatus: "saved", fields }, "local")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Both parts saved privately",
    });
    expect(secretRequestDisplay({ secretStatus: "declined", fields }, "local")).toMatchObject({
      label: "Declined",
    });
  });
});

describe("secretAnswerNoticeIds", () => {
  // As stored: the answer notice is a notification row whose id encodes its message id.
  const card = (id: string) => ({ item: { type: "secret_request", id } });
  const notice = (cardId: string) => ({
    item: {
      type: "notification",
      id: `turn-item:message:${encodeURIComponent(`message:secret-request-answer:${cardId}`)}`,
    },
  });
  const cardId = "turn-item:secret-request:thread%3A1:modal";

  it("hides the notice of a card in the same list, saved or declined", () => {
    const items = [card(cardId), notice(cardId), notice("turn-item:secret-request:other")];
    expect([...secretAnswerNoticeIds(items as never)]).toEqual([notice(cardId).item.id]);
  });

  it("keeps a notice whose card is not loaded, and every other notification", () => {
    const resumed = {
      item: {
        type: "notification",
        id: `turn-item:message:${encodeURIComponent("message:restart-continuation:run-1")}`,
      },
    };
    expect(secretAnswerNoticeIds([notice(cardId), resumed] as never).size).toBe(0);
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});

it("keeps scope and expiry in the private answer, accepts never, and validates custom calendar dates", () => {
  expect(
    secretRequestAnswerInput(item, {
      type: "save",
      values: [" obviously-fake "],
      scope: "all",
      expiresAt: null,
    })?.answer,
  ).toEqual({ type: "save", secret: "obviously-fake", scope: "all", expiresAt: null });
  expect(apiKeyExpiryFromDays(30, 100)).toBe(100 + 30 * 86_400_000);
  expect(apiKeyExpiryFromDays(null, 100)).toBeNull();
  expect(apiKeyCustomExpiry("2027-02-30")).toBeNull();
  expect(apiKeyCustomExpiry("not-a-date")).toBeNull();
  expect(apiKeyCustomExpiry("2028-02-29")).toBeGreaterThan(0);
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});
