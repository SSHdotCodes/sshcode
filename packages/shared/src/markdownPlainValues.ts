const SPACE = String.raw`[ \t\u00a0\u202f]`;
const GAP = `${SPACE}*`;
const PREFIX = `(?:[~≈<>≤≥±]${GAP})?`;
const SIGN = "[+−-]?";
const NUMBER = String.raw`(?:(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)`;
const CURRENCY = "[$€£¥]";
const UNIT =
  "(?:%|t|k|M|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|ns|µs|μs|ms|s|min|h|pp|x|×|fps|Hz|kHz|dB|dBFS)";
const QUANTITY = `${PREFIX}(?:${SIGN}(?:${CURRENCY}${GAP})?|${CURRENCY}${GAP}${SIGN})${NUMBER}(?:${GAP}${UNIT})?`;
const RANGE = `${QUANTITY}${GAP}[-–—]${GAP}${QUANTITY}`;
const FRACTION = `${PREFIX}${SIGN}${NUMBER}${GAP}/${GAP}${SIGN}${NUMBER}`;
const RATIO = "[0-9]+:[0-9]+";
const TIME_ZONE = "(?:UTC|GMT|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT)";
const CLOCK = `${PREFIX}(?:(?:0?[1-9]|1[0-2]):[0-5][0-9]${GAP}(?:AM|PM)|(?:[01]?[0-9]|2[0-3]):[0-5][0-9])(?:${SPACE}+${TIME_ZONE})?`;
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DAY = "(?:0?[1-9]|[12][0-9]|3[01])";
const DATE = `(?:${MONTH}${SPACE}+${DAY}(?:,?${SPACE}+[0-9]{4})?|[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))`;
// Require the multiplication sign and a known GPU model. Arbitrary identifiers stay code.
const GPU_COUNT = `${PREFIX}[1-9][0-9]*${GAP}×${GAP}(?:A100|H100|H200|B200|B300|GB200|GB300)`;

const VALUE = `(?:${QUANTITY}|${RANGE}|${FRACTION}|${RATIO}|${CLOCK}|${DATE}|${GPU_COUNT})`;

/** The native Markdown renderer uses this same pattern against complete inline code spans. */
export const MARKDOWN_PLAIN_VALUE_PATTERN = new RegExp(
  String.raw`^(?=[^\r\n\u2028\u2029]{1,120}$)${GAP}${VALUE}(?:,${SPACE}+${VALUE}){0,3}${GAP}(?![\s\S])`,
  "u",
);

/** Whether a complete inline Markdown code span contains only a short display value. */
export function isMarkdownPlainValue(value: string): boolean {
  return MARKDOWN_PLAIN_VALUE_PATTERN.test(value);
}
