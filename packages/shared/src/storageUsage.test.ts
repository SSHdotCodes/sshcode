import { EnvironmentId, type StorageUsageSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectStorage, describeStorage, formatStorageBytes } from "./storageUsage.ts";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

describe("formatStorageBytes", () => {
  it("uses binary units with two or three significant digits", () => {
    expect(formatStorageBytes(20 * TiB)).toBe("20 TB");
    expect(formatStorageBytes(1.2 * TiB)).toBe("1.2 TB");
    expect(formatStorageBytes(1.254 * TiB)).toBe("1.25 TB");
    expect(formatStorageBytes(3 * GiB)).toBe("3 GB");
    expect(formatStorageBytes(17_088_259)).toBe("16.3 MB");
    expect(formatStorageBytes(123.4 * GiB)).toBe("123 GB");
    expect(formatStorageBytes(32)).toBe("32 B");
    expect(formatStorageBytes(0)).toBe("0 B");
  });

  it("rounds up into the next unit instead of printing 1024", () => {
    expect(formatStorageBytes(1023.8 * GiB)).toBe("1 TB");
  });
});

const drive = (overrides: Partial<StorageUsageSnapshot> = {}): StorageUsageSnapshot => ({
  label: "Google Drive",
  totalBytes: 20 * TiB,
  usedBytes: 1.2 * TiB,
  trashedBytes: 3 * GiB,
  checkedAt: "2026-11-19T12:00:00.000Z",
  ...overrides,
});
const NOW = Date.parse("2026-11-19T12:05:00.000Z");

describe("describeStorage", () => {
  it("reads like the limit cards", () => {
    expect(describeStorage(drive(), NOW)).toEqual({
      usedShare: 0.06,
      used: "1.2 TB of 20 TB used",
      trash: "3 GB in trash",
      checked: "checked 5m ago",
    });
  });

  it("leaves out an empty trash and says just now for a fresh read", () => {
    const text = describeStorage(drive({ trashedBytes: 0 }), Date.parse(drive().checkedAt) + 10);
    expect(text.trash).toBeNull();
    expect(
      describeStorage(drive({ trashedBytes: 32 }), Date.parse(drive().checkedAt)).trash,
    ).toBeNull();
    expect(text.checked).toBe("checked just now");
  });

  it("keeps the bar inside its track", () => {
    expect(describeStorage(drive({ usedBytes: 30 * TiB }), NOW).usedShare).toBe(1);
    expect(describeStorage(drive({ totalBytes: 0 }), NOW).usedShare).toBe(0);
  });
});

describe("collectStorage", () => {
  const presentations = (...storage: Array<StorageUsageSnapshot | undefined>) =>
    new Map(
      storage.map((entry, index) => [
        EnvironmentId.make(`environment-${index}`),
        { serverConfig: entry === undefined ? null : { storage: entry } },
      ]),
    );

  it("shows nothing when no environment publishes storage", () => {
    expect(collectStorage(presentations(undefined, undefined))).toEqual([]);
  });

  it("collapses the same Drive on two machines into the freshest reading", () => {
    const mac = drive({ checkedAt: "2026-11-19T12:00:00.000Z" });
    const studio = drive({ checkedAt: "2026-11-19T12:04:00.000Z", usedBytes: 1.3 * TiB });
    expect(collectStorage(presentations(mac, studio))).toEqual([studio]);
    expect(collectStorage(presentations(studio, mac))).toEqual([studio]);
  });

  it("prefers a working read over a failed one with the same numbers", () => {
    const failed = drive({ error: "token expired" });
    expect(collectStorage(presentations(failed, drive()))).toEqual([drive()]);
  });
});
