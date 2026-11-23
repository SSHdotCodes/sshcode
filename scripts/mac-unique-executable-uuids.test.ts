import { expect, it } from "vite-plus/test";

import { rewriteMachOUuids } from "./mac-unique-executable-uuids.ts";

const ELECTRON_UUID = Buffer.from("4c4c44f855553144a1b8270b7145eda0", "hex");

/** A minimal 64-bit Mach-O: header, one unrelated load command, then LC_UUID. */
const thinImage = (): Buffer => {
  const image = Buffer.alloc(32 + 16 + 24);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(2, 16);
  image.writeUInt32LE(40, 20);
  image.writeUInt32LE(0x32, 32);
  image.writeUInt32LE(16, 36);
  image.writeUInt32LE(0x1b, 48);
  image.writeUInt32LE(24, 52);
  ELECTRON_UUID.copy(image, 56);
  return image;
};

const uuidOf = (image: Buffer, offset = 0) =>
  image.subarray(offset + 56, offset + 72).toString("hex");

it("gives each app and executable its own stable UUID", () => {
  const ours = thinImage();
  const again = thinImage();
  const otherApp = thinImage();
  const helper = thinImage();

  expect(rewriteMachOUuids(ours, "com.t3tools.t3code.fork@1.0:Contents/MacOS/SSHCode")).toBe(1);
  rewriteMachOUuids(again, "com.t3tools.t3code.fork@1.0:Contents/MacOS/SSHCode");
  rewriteMachOUuids(otherApp, "com.t3tools.t3code@1.0:Contents/MacOS/SSHCode");
  rewriteMachOUuids(helper, "com.t3tools.t3code.fork@1.0:Contents/Frameworks/SSHCode Helper.app");

  expect(uuidOf(ours)).not.toBe(ELECTRON_UUID.toString("hex"));
  expect(uuidOf(again)).toBe(uuidOf(ours));
  expect(new Set([uuidOf(ours), uuidOf(otherApp), uuidOf(helper)]).size).toBe(3);
  expect(ours.readUInt8(56 + 6) >> 4).toBe(8);
  expect(ours.subarray(0, 56)).toEqual(thinImage().subarray(0, 56));
});

it("rewrites every slice of a universal binary differently", () => {
  const universal = Buffer.alloc(3 * 4096);
  universal.writeUInt32BE(0xcafebabe, 0);
  universal.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    universal.writeUInt32BE(cpu, 8 + index * 20);
    universal.writeUInt32BE((index + 1) * 4096, 8 + index * 20 + 8);
    thinImage().copy(universal, (index + 1) * 4096);
  }

  expect(rewriteMachOUuids(universal, "seed")).toBe(2);
  expect(uuidOf(universal, 4096)).not.toBe(uuidOf(universal, 8192));
});

it("refuses files that are not 64-bit Mach-O images", () => {
  expect(() => rewriteMachOUuids(Buffer.alloc(64), "seed")).toThrow(/Mach-O/);
});
