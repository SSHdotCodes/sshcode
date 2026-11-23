import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NoteId = TrimmedNonEmptyString.pipe(Schema.brand("NoteId"));
export type NoteId = typeof NoteId.Type;

const NoteText = TrimmedNonEmptyString.check(Schema.isMaxLength(10_000));

export const Note = Schema.Struct({
  id: NoteId,
  text: NoteText,
  done: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Note = typeof Note.Type;

export const NotesState = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(Note),
});
export type NotesState = typeof NotesState.Type;

/** Mutations address individual items; a reorder moves only one item. */
export const NoteOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add"), id: NoteId, text: NoteText }),
  Schema.Struct({ type: Schema.Literal("updateText"), id: NoteId, text: NoteText }),
  Schema.Struct({ type: Schema.Literal("setDone"), id: NoteId, done: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("delete"), id: NoteId }),
  Schema.Struct({
    type: Schema.Literal("reorder"),
    id: NoteId,
    beforeId: Schema.NullOr(NoteId),
  }),
  Schema.Struct({ type: Schema.Literal("clearDone") }),
]);
export type NoteOperation = typeof NoteOperation.Type;

export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  operation: Schema.Literals(["read", "decode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ${this.operation} notes.`;
  }
}
