export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;

  // Keep slice's behavior for negative limits. Title previews normally need only a short prefix.
  if (maxLength < 0) return `${Array.from(trimmed).slice(0, maxLength).join("").trimEnd()}...`;
  const limit = Math.trunc(maxLength) || 0;
  let count = 0;
  let end = 0;
  for (const char of trimmed) {
    if (count === limit) return `${trimmed.slice(0, end).trimEnd()}...`;
    end += char.length;
    count++;
  }
  return trimmed;
}
