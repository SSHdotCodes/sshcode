import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

const preparations = Atom.make<Readonly<Record<string, ReadonlyMap<symbol, string>>>>({}).pipe(
  Atom.keepAlive,
);

const preparationName = Atom.family((key: string | null | undefined) =>
  Atom.map(preparations, (drafts) => (key ? drafts[key]?.values().next().value : undefined)),
);

export function useCompressingComposerVideo(draftKey: string | null | undefined) {
  return useAtomValue(preparationName(draftKey));
}

export function isCompressingComposerVideo(draftKey: string): boolean {
  return appAtomRegistry.get(preparationName(draftKey)) !== undefined;
}

/** Keeps the status visible until the picker results are committed to this draft. */
export async function withComposerVideoPreparation<T>(
  draftKey: string,
  operation: (report: (name: string) => void) => Promise<T>,
): Promise<T> {
  const id = Symbol();
  try {
    return await operation((name) => {
      const current = appAtomRegistry.get(preparations);
      const jobs = new Map(current[draftKey]);
      jobs.set(id, name);
      appAtomRegistry.set(preparations, { ...current, [draftKey]: jobs });
    });
  } finally {
    const current = appAtomRegistry.get(preparations);
    if (current[draftKey]?.has(id)) {
      const jobs = new Map(current[draftKey]);
      jobs.delete(id);
      const next = { ...current };
      if (jobs.size > 0) next[draftKey] = jobs;
      else delete next[draftKey];
      appAtomRegistry.set(preparations, next);
    }
  }
}
