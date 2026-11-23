import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { CommandId, type SideChatState } from "@t3tools/contracts";
import { writeFileAtomically } from "../lib/atomic-file";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { createPendingSendManager, type PendingSendStorage } from "./pending-send-manager";
import { PendingSendSchema, type PendingSend } from "./pending-send-model";

const decode = Schema.decodeUnknownSync(PendingSendSchema);
async function directory() {
  const { Directory, Paths } = await import("expo-file-system");
  const result = new Directory(Paths.document, "pending-sends");
  result.create({ idempotent: true, intermediates: true });
  return result;
}
async function file(send: PendingSend) {
  const { File } = await import("expo-file-system");
  return new File(await directory(), `${encodeURIComponent(send.id)}.json`);
}
export const pendingSendStorage: PendingSendStorage = {
  load: async () => {
    const { File } = await import("expo-file-system");
    const sends: PendingSend[] = [];
    const errors: unknown[] = [];
    for (const entry of (await directory()).list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
      try {
        sends.push(decode(JSON.parse(await entry.text())));
      } catch (error) {
        errors.push(error);
      }
    }
    return { sends, errors };
  },
  write: async (send) => writeFileAtomically(await file(send), JSON.stringify(send)),
  remove: async (send) => {
    const stored = await file(send);
    if (stored.exists) stored.delete();
  },
};
export const pendingSends = createPendingSendManager(appAtomRegistry, pendingSendStorage);
// An accepted open response can beat the side-chat subscription's first snapshot.
export const acknowledgedSideChatsAtom = Atom.make<Readonly<Record<string, SideChatState>>>(
  {},
).pipe(Atom.keepAlive);
export const acknowledgedUserInputKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);
export function pendingSendMetadata() {
  return { id: CommandId.make(`mobile-send:${uuidv4()}`), createdAt: new Date().toISOString() };
}
