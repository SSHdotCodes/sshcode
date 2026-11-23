// Sandboxed preloads can't require workspace packages at runtime, so the
// preload reads this copy. desktopMediaLimits.test.ts keeps it equal to the
// contracts value the main process and renderer use.
export const DESKTOP_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
