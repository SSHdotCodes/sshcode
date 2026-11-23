import { describe, expect, it } from "vite-plus/test";
import { readProfile, writeProfile, resizeProfile } from "./profileImage";

describe("local Discord profile settings", () => {
  it("persists, restores and removes the selected picture", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    expect(readProfile(storage)).toBeNull();
    writeProfile(storage, "data:image/png;base64,aGVsbG8=");
    expect(readProfile(storage)).toBe("data:image/png;base64,aGVsbG8=");
    writeProfile(storage, null);
    expect(readProfile(storage)).toBeNull();
  });
  it("falls back to initials for corrupt or unavailable storage", () => {
    expect(readProfile({ getItem: () => "https://example.test/avatar" })).toBeNull();
    expect(
      readProfile({
        getItem: () => {
          throw new Error("Unavailable");
        },
      }),
    ).toBeNull();
  });
  it("rejects unsafe image types and oversized uploads before decoding", async () => {
    await expect(
      resizeProfile(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })),
    ).rejects.toThrow("Choose a PNG");
    await expect(
      resizeProfile(new File([new Uint8Array(11 * 1024 * 1024)], "a.png", { type: "image/png" })),
    ).rejects.toThrow("under 10 MB");
  });
});
