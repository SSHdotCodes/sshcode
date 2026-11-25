import { Atom } from "effect/reactivity";
import type { RuntimeRequestId } from "@t3tools/contracts";

/** Bridge the command receipt to the projection that removes the question card. */
export const answeredRequestsAtom = Atom.family((_threadKey: string) =>
  Atom.make<ReadonlySet<RuntimeRequestId>>(new Set<RuntimeRequestId>()).pipe(
    Atom.setIdleTTL("5 minutes"),
  ),
);

export function forgetResolvedAnswers(
  answered: ReadonlySet<RuntimeRequestId>,
  requests: ReadonlyArray<{ readonly id: RuntimeRequestId; readonly status: string }>,
): ReadonlySet<RuntimeRequestId> {
  let remaining: Set<RuntimeRequestId> | undefined;
  for (const request of requests) {
    if (request.status !== "pending" && answered.has(request.id)) {
      (remaining ??= new Set(answered)).delete(request.id);
    }
  }
  return remaining ?? answered;
}
