import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";

export const layer = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop"]),
);

const sensitiveQueryName = (name: string) => {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return true;
  }
  return /(?:token|ticket|signature|credential|secret|password|authorization|proof|api.?key|^sig$|^code$|^dpop$|^auth$|^key$)/i.test(
    decoded,
  );
};

/** Safe for relative request targets and absolute outgoing signed URLs. */
export const redactHttpUrl = (value: string): string =>
  value
    .replace(
      /(\/api\/(?:assets|attachments\/upload|webhooks|debug-log)\/)[^/?#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\/api\/debug-log\/)[^?#\s]+/gi, "$1[REDACTED]")
    .replace(/(\/api\/hooks\/[^/?#\s]+\/)[^/?#\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, name: string) =>
      sensitiveQueryName(name) ? `${separator}${name}=[REDACTED]` : match,
    );

/** Redact before handing attributes to either the local tracer or its OTLP delegate. */
export const redactHttpAttribute = (
  key: string,
  value: unknown,
  seen?: WeakSet<object>,
): unknown => {
  if (typeof value === "string") {
    if (/^(?:url\.query|http\.query)$/.test(key)) return redactHttpUrl(`?${value}`).slice(1);
    return redactHttpUrl(value);
  }
  if (value instanceof Error) {
    const message = redactHttpUrl(value.message);
    const stack = value.stack === undefined ? undefined : redactHttpUrl(value.stack);
    if (message === value.message && stack === value.stack) return value;
    const error = new Error(message);
    error.name = value.name;
    if (stack !== undefined) error.stack = stack;
    else delete error.stack;
    return error;
  }
  if (value !== null && typeof value === "object") {
    const visited = seen ?? new WeakSet<object>();
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
    if (Array.isArray(value)) return value.map((entry) => redactHttpAttribute(key, entry, visited));
    if (Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          redactHttpAttribute(name, entry, visited),
        ]),
      );
    }
  }
  return value;
};

/** Scrubs renderer OTLP JSON before either local collection or forwarding to an exporter. */
export const redactHttpTelemetry = (value: unknown): unknown => {
  if (typeof value === "string") return redactHttpUrl(value);
  if (Array.isArray(value)) return value.map(redactHttpTelemetry);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (
        key === "value" &&
        "key" in value &&
        typeof value.key === "string" &&
        entry !== null &&
        typeof entry === "object" &&
        "stringValue" in entry
      ) {
        return [key, { ...entry, stringValue: redactHttpAttribute(value.key, entry.stringValue) }];
      }
      return [key, redactHttpTelemetry(entry)];
    }),
  );
};
