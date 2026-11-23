import type { NoteOperation, NotesState } from "@t3tools/contracts";

/** Deleted items stay deleted when an edit from another client arrives later. */
export function applyNoteOperation(
  state: NotesState,
  operation: NoteOperation,
  now: string,
): NotesState {
  switch (operation.type) {
    case "add":
      if (state.items.some((item) => item.id === operation.id)) return state;
      return {
        ...state,
        items: [
          ...state.items,
          { id: operation.id, text: operation.text, done: false, createdAt: now, updatedAt: now },
        ],
      };
    case "updateText":
    case "setDone": {
      const item = state.items.find((item) => item.id === operation.id);
      if (
        item === undefined ||
        (operation.type === "updateText"
          ? item.text === operation.text
          : item.done === operation.done)
      )
        return state;
      return {
        ...state,
        items: state.items.map((item) =>
          item.id !== operation.id
            ? item
            : {
                ...item,
                ...(operation.type === "updateText"
                  ? { text: operation.text }
                  : { done: operation.done }),
                updatedAt: now,
              },
        ),
      };
    }
    case "delete":
    case "clearDone": {
      const items = state.items.filter((item) =>
        operation.type === "delete" ? item.id !== operation.id : !item.done,
      );
      return items.length === state.items.length ? state : { ...state, items };
    }
    case "reorder": {
      const item = state.items.find((item) => item.id === operation.id);
      if (item === undefined || operation.id === operation.beforeId) return state;
      const items = state.items.filter((item) => item.id !== operation.id);
      const index =
        operation.beforeId === null
          ? items.length
          : items.findIndex((item) => item.id === operation.beforeId);
      // A stale drop target must not move an item somewhere the user did not ask for.
      if (index < 0) return state;
      items.splice(index, 0, { ...item, updatedAt: now });
      return { ...state, items };
    }
  }
}
