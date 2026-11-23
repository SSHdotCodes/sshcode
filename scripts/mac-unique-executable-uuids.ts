// @effect-diagnostics nodeBuiltinImport:off -- electron-builder loads this hook as plain Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

// Electron ships its app and helper executables prebuilt, so every Electron app
// of one version carries the same Mach-O build UUIDs. macOS keys Local Network
// permission (and crash symbolication) by that UUID, so SSHCode inherited
// SSHCode's answer instead of asking for its own. Apple TN3178 asks each
// distinct image to have its own UUID; this hook gives the app and helper
// executables one derived from the app ID and version.

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const derivedUuid = (seed: string): Buffer => {
  const bytes = NodeCrypto.createHash("sha256").update(seed).digest().subarray(0, 16);
  // RFC 9562 name-based layout: version 8, RFC variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Buffer.from(bytes);
};

const rewriteSlice = (data: Buffer, offset: number, seed: string): number => {
  if (data.readUInt32LE(offset) !== MH_MAGIC_64) {
    throw new Error("Expected a 64-bit little-endian Mach-O image");
  }
  const count = data.readUInt32LE(offset + 16);
  const commandsSize = data.readUInt32LE(offset + 20);
  const end = offset + 32 + commandsSize;
  let cursor = offset + 32;
  let rewritten = 0;
  for (let index = 0; index < count; index += 1) {
    const command = data.readUInt32LE(cursor);
    const size = data.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > end) throw new Error("Malformed Mach-O load commands");
    if (command === LC_UUID) {
      derivedUuid(seed).copy(data, cursor + 8);
      rewritten += 1;
    }
    cursor += size;
  }
  return rewritten;
};

/** Replace every LC_UUID in a thin or universal Mach-O with one derived from `seed`. */
export const rewriteMachOUuids = (data: Buffer, seed: string): number => {
  const magic = data.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return rewriteSlice(data, 0, seed);
  const entrySize = magic === FAT_MAGIC_64 ? 32 : 20;
  let rewritten = 0;
  for (let index = 0; index < data.readUInt32BE(4); index += 1) {
    const entry = 8 + index * entrySize;
    const offset =
      magic === FAT_MAGIC_64
        ? Number(data.readBigUInt64BE(entry + 8))
        : data.readUInt32BE(entry + 8);
    rewritten += rewriteSlice(data, offset, `${seed}#${data.readUInt32BE(entry)}`);
  }
  return rewritten;
};

const executablesIn = async (directory: string): Promise<string[]> =>
  (await NodeFSP.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.join(directory, entry.name));

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: {
    readonly appInfo: {
      readonly id: string;
      readonly version: string;
      readonly productFilename: string;
    };
  };
}

export default async function afterPack(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const { id, version, productFilename } = context.packager.appInfo;
  const app = NodePath.join(context.appOutDir, `${productFilename}.app`);
  const frameworks = NodePath.join(app, "Contents", "Frameworks");
  const helpers = (await NodeFSP.readdir(frameworks)).filter((name) => name.endsWith(".app"));
  const executables = [
    ...(await executablesIn(NodePath.join(app, "Contents", "MacOS"))),
    ...(
      await Promise.all(
        helpers.map((helper) =>
          executablesIn(NodePath.join(frameworks, helper, "Contents", "MacOS")),
        ),
      )
    ).flat(),
  ];
  for (const executable of executables) {
    const data = await NodeFSP.readFile(executable);
    const seed = `${id}@${version}:${NodePath.relative(app, executable)}`;
    if (rewriteMachOUuids(data, seed) === 0) throw new Error(`${executable} has no LC_UUID`);
    await NodeFSP.writeFile(executable, data);
  }
  // Editing the executables breaks Electron's ad hoc signatures. Unsigned builds
  // are not signed again, so restore a valid ad hoc signature; a configured
  // identity re-signs everything with --force afterwards.
  await NodeUtil.promisify(NodeChildProcess.execFile)("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    app,
  ]);
}
