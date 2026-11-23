import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { NoteId, NoteOperation, NotesState } from "./notes.ts";

const decodeOperation = Schema.decodeSync(NoteOperation);
const encodeState = Schema.encodeSync(Schema.fromJsonString(NotesState));
const decodeState = Schema.decodeSync(Schema.fromJsonString(NotesState));
const id = NoteId.make("idea");

describe("notes contracts", () => {
  it("trims captured text and rejects blank or oversized ideas", () => {
    expect(decodeOperation({ type: "add", id, text: "  An idea  " })).toEqual({
      type: "add",
      id,
      text: "An idea",
    });
    expect(() => decodeOperation({ type: "updateText", id, text: "   " })).toThrow();
    expect(() => decodeOperation({ type: "add", id, text: "x".repeat(10_001) })).toThrow();
  });

  it("round-trips state without losing order, completion, or timestamps", () => {
    const state: NotesState = {
      version: 1,
      items: [
        {
          id,
          text: "An idea",
          done: true,
          createdAt: "2026-10-15T00:00:00Z",
          updatedAt: "2026-10-15T01:00:00Z",
        },
        {
          id: NoteId.make("another"),
          text: "Next idea",
          done: false,
          createdAt: "2026-10-15T02:00:00Z",
          updatedAt: "2026-10-15T02:00:00Z",
        },
      ],
    };
    expect(decodeState(encodeState(state))).toEqual(state);
  });
});
