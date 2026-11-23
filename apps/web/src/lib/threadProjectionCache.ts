/**
 * One level of equality without allocating. Streaming replaces a transcript
 * array on every chunk and changes its tail, so arrays compare from the end.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = left.length - 1; index >= 0; index--) {
      if (!Object.is(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !Object.is(value, right.get(key))) return false;
    }
    return true;
  }
  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Object.getPrototypeOf(left) !== Object.prototype ||
    Object.getPrototypeOf(right) !== Object.prototype
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/** Retain a few warm transcripts across route remounts without retaining every visited chat. */
export function createThreadProjectionCache<Input extends object, Projection>(
  derive: (input: Input, previous: Projection | null) => Projection,
  limit = 8,
) {
  const entries = new Map<
    string | null,
    { input: Input; scope: unknown; projection: Projection }
  >();
  return (key: string | null, input: Input, scope?: unknown): Projection => {
    const previous = entries.get(key);
    let projection: Projection;
    if (
      previous &&
      previous.scope === scope &&
      Object.keys(input).length === Object.keys(previous.input).length &&
      Object.entries(input).every(([field, value]) =>
        sameValue(value, previous.input[field as keyof Input]),
      )
    ) {
      projection = previous.projection;
    } else {
      projection = derive(input, previous && previous.scope === scope ? previous.projection : null);
    }
    entries.delete(key);
    entries.set(key, { input, scope, projection });
    if (entries.size > limit) entries.delete(entries.keys().next().value!);
    return projection;
  };
}
