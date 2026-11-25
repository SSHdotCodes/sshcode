/** Two decimals under 10, one under 100, none above, judged after rounding (9.996 reads 10.0). */
function formatScaled(value: number): string {
  const twoDecimals = value.toFixed(2);
  if (Number(twoDecimals) < 10) return twoDecimals;
  const oneDecimal = value.toFixed(1);
  if (Number(oneDecimal) < 100) return oneDecimal;
  return value.toFixed(0);
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${formatScaled(next)} ${units[unitIndex]}`;
}
