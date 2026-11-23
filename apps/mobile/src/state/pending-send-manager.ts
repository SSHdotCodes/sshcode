import { Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { pendingSendKey, type PendingSend } from "./pending-send-model";

export interface PendingSendStorage {
  readonly load: () => Promise<{
    readonly sends: ReadonlyArray<PendingSend>;
    readonly errors: ReadonlyArray<unknown>;
  }>;
  readonly write: (send: PendingSend) => Promise<void>;
  readonly remove: (send: PendingSend) => Promise<void>;
}

/** Side questions and card answers are durable before their inputs clear. */
export function createPendingSendManager(
  registry: AtomRegistry.AtomRegistry,
  storage: PendingSendStorage,
) {
  const sendsAtom = Atom.make<ReadonlyArray<PendingSend>>([]).pipe(Atom.keepAlive);
  let mutations: Promise<unknown> = Promise.resolve();
  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = mutations.then(operation, operation);
    mutations = result.catch(() => undefined);
    return result;
  };
  const current = () => registry.get(sendsAtom);
  const set = (sends: ReadonlyArray<PendingSend>) => registry.set(sendsAtom, sends);
  const load = () =>
    serialize(async () => {
      const result = await storage.load();
      const keys = new Set(current().map(pendingSendKey));
      const recovered = [...result.sends]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter((send) => {
          const key = pendingSendKey(send);
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        });
      set([...current(), ...recovered]);
      if (result.errors.length > 0)
        throw new AggregateError(result.errors, "Some pending sends could not be read.");
    });
  const enqueue = (send: PendingSend) =>
    serialize(async () => {
      const existing = current().find((item) => pendingSendKey(item) === pendingSendKey(send));
      // Repeated taps and lost acknowledgments reuse the accepted payload and id.
      if (
        existing?.kind === "side-question" &&
        send.kind === "side-question" &&
        existing.prompt !== send.prompt
      ) {
        throw new Error(
          "A side question is already waiting to send. Your new question is still in the composer.",
        );
      }
      if (existing && !existing.error) return existing;
      await storage.write(send);
      set([...current().filter((item) => item !== existing), send]);
      if (existing && existing.id !== send.id)
        await storage.remove(existing).catch(() => undefined);
      return send;
    });
  const remove = (send: PendingSend) =>
    serialize(async () => {
      await storage.remove(send);
      set(current().filter((item) => item.id !== send.id));
    });
  const fail = (send: PendingSend, error: string) =>
    serialize(async () => {
      if (!current().some((item) => item.id === send.id)) return;
      const failed = { ...send, error };
      await storage.write(failed);
      set(current().map((item) => (item.id === send.id ? failed : item)));
    });
  const retry = (send: PendingSend) =>
    serialize(async () => {
      if (!current().some((item) => item.id === send.id)) return;
      const { error: _, ...pending } = send;
      await storage.write(pending);
      set(current().map((item) => (item.id === send.id ? pending : item)));
    });
  const clearEnvironment = async (environmentId: EnvironmentId) => {
    await load();
    for (const send of current().filter((item) => item.environmentId === environmentId))
      await remove(send);
  };
  return {
    sendsAtom,
    load,
    enqueue,
    remove,
    fail,
    retry,
    clearEnvironment,
    flush: () => mutations.then(() => undefined),
  };
}
