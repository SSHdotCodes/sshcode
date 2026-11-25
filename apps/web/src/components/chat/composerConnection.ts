import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { approvalRedirectDraftFingerprint } from "./approvalRedirect";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

/** The supervisor can still supply a session without switching or re-pairing the environment. */
export function canWaitForComposerConnection(phase: EnvironmentConnectionPhase) {
  return phase === "connecting" || phase === "reconnecting" || phase === "offline";
}

/** Upload progress may advance while the socket reconnects; only the submitted content owns this send. */
export async function waitForComposerDraftConnection(
  readDraft: () => ComposerThreadDraftState | null,
  waitForSession: () => Promise<{ readonly _tag: "Success" | "Failure" }>,
): Promise<string | null> {
  const content = approvalRedirectDraftFingerprint(readDraft());
  if ((await waitForSession())._tag === "Failure")
    return "Could not reconnect. Your draft is still in the composer.";
  if (approvalRedirectDraftFingerprint(readDraft()) !== content)
    return "The draft changed while reconnecting. Review it before sending.";
  return null;
}
