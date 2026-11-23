// Byte hashes by file; a file whose bytes were never read gets a key that matches only itself.
const composerImageFingerprints = new WeakMap<File, string>();
let unreadComposerImageCount = 0;

function composerImageFingerprint(file: File): string {
  let fingerprint = composerImageFingerprints.get(file);
  if (fingerprint === undefined) {
    fingerprint = `unread:${unreadComposerImageCount++}`;
    composerImageFingerprints.set(file, fingerprint);
  }
  return fingerprint;
}

/** Records the bytes behind an image file, so a draft drops it only as a byte-for-byte repeat. */
export function rememberComposerImageBytes(file: File, bytes: Uint8Array): void {
  // cyrb53, synchronous: crypto.subtle is missing on plain-http remote origins.
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    first = Math.imul(first ^ byte, 2654435761);
    second = Math.imul(second ^ byte, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  composerImageFingerprints.set(file, `${second >>> 0}:${first >>> 0}`);
}

export async function readComposerImageBytes(file: File): Promise<void> {
  // An unreadable file keeps matching only itself.
  const bytes = await file.arrayBuffer().catch(() => null);
  if (bytes) rememberComposerImageBytes(file, new Uint8Array(bytes));
}

/**
 * The draft's image dedupe key: name, type, size and bytes. Pasted images all share one
 * name, so metadata alone would drop a distinct image. Files whose bytes were never read
 * match only themselves; producers that want dedupe await readComposerImageBytes first.
 */
export function composerImageDedupKey(image: {
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly name: string;
  readonly file: File;
}): string {
  // Hydrated images get fresh lastModified values, so exclude it from dedupe.
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}\u0000${composerImageFingerprint(image.file)}`;
}
