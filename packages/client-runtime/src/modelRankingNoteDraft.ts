export function create(value: string) {
  return { source: value, baseline: value, text: value };
}

type Draft = ReturnType<typeof create>;

export function change(draft: Draft, text: string): Draft {
  return { ...draft, text };
}

/** Source snapshots may lag an acknowledged save. Keep that baseline separate. */
export function receive(draft: Draft, source: string): Draft {
  if (source === draft.source) return draft;
  return {
    source,
    baseline: source,
    text: draft.text.trim() === draft.baseline ? source : draft.text,
  };
}

export function commitValue(draft: Draft): string | null {
  const text = draft.text.trim();
  return text === draft.baseline ? null : text;
}

/** An older save must not clear text entered while that request was pending. */
export function acknowledge(draft: Draft, submitted: string): Draft {
  return {
    ...draft,
    baseline: submitted,
    text: draft.text.trim() === submitted ? submitted : draft.text,
  };
}
