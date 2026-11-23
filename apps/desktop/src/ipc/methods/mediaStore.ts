// @effect-diagnostics nodeBuiltinImport:off -- Desktop media is materialized on the local machine for Finder and Quick Look.
// @effect-diagnostics globalDate:off globalTimers:off -- The temp store schedules its own bounded cleanup outside an Effect fiber.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { DESKTOP_MEDIA_MAX_BYTES } from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";

export const MAX_DESKTOP_MEDIA_BYTES = DESKTOP_MEDIA_MAX_BYTES;
const MAX_TEMP_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_TEMP_MEDIA_FILES = 64;
const MEDIA_LIFETIME_MS = 10 * 60 * 1000;

export function validateDesktopMediaInput(
  value: unknown,
): value is { name: string; mimeType: string; bytes: Uint8Array } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    !("mimeType" in value) ||
    !("bytes" in value)
  )
    return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 255 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length <= 100 &&
    /^(image|video)\/[a-z0-9.+*-]+$/i.test(value.mimeType) &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 0 &&
    value.bytes.byteLength <= MAX_DESKTOP_MEDIA_BYTES
  );
}

function safeMediaName(name: string, mimeType: string): string {
  const safe =
    Array.from(name, (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || "\\/:".includes(character)
        ? "_"
        : character,
    )
      .join("")
      .replace(/^\.+/, "")
      .slice(0, 180) || "media";
  const extension = NodePath.extname(safe).toLowerCase();
  if (mediaMimeTypeFromExtension(extension)) return safe;
  const fallback =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/gif"
        ? ".gif"
        : mimeType === "image/webp"
          ? ".webp"
          : mimeType.startsWith("video/")
            ? ".mp4"
            : ".png";
  return safe + fallback;
}

type FileEntry = {
  readonly path: string;
  readonly directory: string;
  readonly size: number;
  readonly expiresAt: number;
};

/** Owns only randomly named directories under the operating system's temp directory. */
export class DesktopMediaStore {
  private readonly entries = new Map<string, FileEntry>();
  private previewToken: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  static async create() {
    return new DesktopMediaStore(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sshcode-media-")),
    );
  }

  private serialized<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async prepare(input: unknown): Promise<string> {
    if (!validateDesktopMediaInput(input)) throw new Error("Invalid media data.");
    return this.serialized(async () => {
      if (this.disposed) throw new Error("Media preparation is unavailable.");
      await this.cleanExpired();
      const total = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
      if (
        this.entries.size >= MAX_TEMP_MEDIA_FILES ||
        total + input.bytes.byteLength > MAX_TEMP_MEDIA_BYTES
      )
        throw new Error("Too much media is being prepared. Try again later.");
      const token = NodeCrypto.randomUUID();
      const directory = NodePath.join(this.root, token);
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      const filePath = NodePath.join(directory, safeMediaName(input.name, input.mimeType));
      try {
        await NodeFSP.writeFile(filePath, input.bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await NodeFSP.rm(directory, { recursive: true, force: true });
        throw error;
      }
      this.entries.set(token, {
        path: filePath,
        directory,
        size: input.bytes.byteLength,
        expiresAt: Date.now() + MEDIA_LIFETIME_MS,
      });
      this.scheduleCleanup();
      return token;
    });
  }
  get(token: unknown): string | null {
    return typeof token === "string" ? (this.entries.get(token)?.path ?? null) : null;
  }
  pinPreview(token: string) {
    this.previewToken = token;
    this.scheduleCleanup();
  }
  closePreview(token: string): boolean {
    if (this.previewToken !== token) return false;
    this.previewToken = null;
    this.scheduleCleanup();
    return true;
  }
  private async cleanExpired() {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (token === this.previewToken || entry.expiresAt > now) continue;
      this.entries.delete(token);
      await NodeFSP.rm(entry.directory, { recursive: true, force: true });
    }
  }
  private scheduleCleanup() {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const deadlines = [...this.entries]
      .filter(([token]) => token !== this.previewToken)
      .map(([, entry]) => entry.expiresAt);
    if (!deadlines.length) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.serialized(() => this.cleanExpired())
          .catch(() => undefined)
          .finally(() => {
            if (!this.disposed) this.scheduleCleanup();
          });
      },
      Math.max(1, Math.min(...deadlines) - Date.now()),
    );
    this.timer.unref();
  }
  async dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.queue;
    this.entries.clear();
    await NodeFSP.rm(this.root, { recursive: true, force: true });
  }
}
