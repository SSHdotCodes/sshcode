import type { SelectedFields } from "@t3tools/provider-core/server/usage";

/**
 * Projects timing envelopes without decoding tool outputs. JSON strings are
 * skipped with native searches; only selected values are materialised. Large
 * lines still use the reader's streaming JSON parser.
 */
export function projectUsageMetadata(bytes: Buffer, fields: SelectedFields): unknown {
  // latin1 preserves byte offsets and avoids decoding megabytes of tool text.
  // Selected values alone are decoded as UTF-8 before native JSON parsing.
  const text = bytes.toString("latin1");
  const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
  let cursor = 0;
  const whitespace = () => {
    while (cursor < text.length) {
      const char = text.charCodeAt(cursor);
      if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
      cursor++;
    }
  };
  const stringEnd = (start: number) => {
    let end = start;
    for (;;) {
      end = text.indexOf('"', end + 1);
      if (end < 0) throw new SyntaxError("Unterminated string");
      let backslash = end - 1;
      while (text[backslash] === "\\") backslash--;
      if ((end - backslash) % 2 === 1) return end + 1;
    }
  };
  const skip = () => {
    whitespace();
    if (text[cursor] === '"') {
      cursor = stringEnd(cursor);
      return;
    }
    if (text[cursor] !== "{" && text[cursor] !== "[") {
      const start = cursor;
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
      if (!scalar.test(text.slice(start, cursor))) throw new SyntaxError("Invalid scalar");
      return;
    }
    const stack: string[] = [];
    const structural = /["{}[\]]/g;
    structural.lastIndex = cursor;
    for (;;) {
      const token = structural.exec(text);
      if (token === null) throw new SyntaxError("Unterminated value");
      const char = token[0];
      if (char === '"') structural.lastIndex = stringEnd(token.index);
      else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
      else {
        if (stack.pop() !== char) throw new SyntaxError("Mismatched value");
        if (stack.length === 0) {
          cursor = structural.lastIndex;
          return;
        }
      }
    }
  };
  const object = (selected: SelectedFields): string => {
    whitespace();
    if (text[cursor++] !== "{") throw new SyntaxError("Expected object");
    const out: string[] = [];
    whitespace();
    if (text[cursor] === "}") {
      cursor++;
      return "{}";
    }
    for (;;) {
      whitespace();
      if (text[cursor] !== '"') throw new SyntaxError("Expected key");
      const keyStart = cursor;
      const end = stringEnd(cursor);
      const rawKey = text.slice(cursor + 1, end - 1);
      const key: string = rawKey.includes("\\")
        ? JSON.parse(bytes.toString("utf8", cursor, end))
        : rawKey;
      cursor = end;
      whitespace();
      if (text[cursor++] !== ":") throw new SyntaxError("Expected colon");
      whitespace();
      const selection = Object.hasOwn(selected, key) ? selected[key] : undefined;
      const prefix = selection === undefined ? "" : bytes.toString("utf8", keyStart, end) + ":";
      if (selection !== undefined && selection !== true && text[cursor] === "{")
        out.push(prefix + object(selection));
      else {
        const start = cursor;
        skip();
        if (selection !== undefined) out.push(prefix + bytes.toString("utf8", start, cursor));
      }
      whitespace();
      const separator = text[cursor++];
      if (separator === "}") return "{" + out.join(",") + "}";
      if (separator !== ",") throw new SyntaxError("Expected separator");
    }
  };
  const out = object(fields);
  whitespace();
  if (cursor !== text.length) throw new SyntaxError("Trailing data");
  return JSON.parse(out);
}
