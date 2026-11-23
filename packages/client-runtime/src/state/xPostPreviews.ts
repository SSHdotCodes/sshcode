import type { XPostPreview } from "@t3tools/contracts";

/**
 * What each linked X post looks like, kept for the session so a chat scrolled
 * back into view draws its cards at once. In memory only, and small.
 */
const MAX_REMEMBERED = 200;
const remembered = new Map<string, XPostPreview | null>();
const loading = new Map<string, Promise<XPostPreview | null | undefined>>();

/** `undefined`: not looked up yet. `null`: looked up, nothing to show. */
export function rememberedXPostPreview(key: string): XPostPreview | null | undefined {
  return remembered.has(key) ? (remembered.get(key) ?? null) : undefined;
}

/**
 * One lookup per post, however many cards ask at once. `read` resolves
 * `undefined` for a failed call (offline, or a server without the lookup);
 * that is not remembered, so the card can still appear the next time it is drawn.
 */
export function loadXPostPreview(
  key: string,
  read: () => Promise<XPostPreview | null | undefined>,
): Promise<XPostPreview | null | undefined> {
  const running = loading.get(key);
  if (running) return running;
  const request = read()
    .then(
      (value) => {
        if (value !== undefined) {
          remembered.delete(key);
          remembered.set(key, value);
          const oldest = remembered.keys().next().value;
          if (remembered.size > MAX_REMEMBERED && oldest !== undefined) remembered.delete(oldest);
        }
        return value;
      },
      () => undefined,
    )
    .finally(() => {
      loading.delete(key);
    });
  loading.set(key, request);
  return request;
}
